/**
 * [임시 점검 — 병합 금지, 읽기 전용, 시험 횟수에 넣지 않음] L-0b: L-0에서 남은 DART 확인(임원·주요주주 소유보고 이력, 본문 받기 실패 원인, 접수번호 날짜와 rcept_dt 불일치).
 * DART 요청 30건 이하(키 DART_API_KEY_3 → DART_API_KEY_2, 운영 키 금지, 키 값 출력 금지). DB는 dart_corp_codes 읽기만, 쓰기 0. 숫자와 표만 출력한다.
 */
import AdmZip from "adm-zip";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { DartKeyPool } from "./dartKeyPool";

const T0 = Date.now();
const BASE = "https://opendart.fss.or.kr/api";
const REQUEST_CAP = 30;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
let pool: DartKeyPool;
let nextSlot = 0;
async function slot(): Promise<void> { const now = Date.now(); const s = Math.max(now, nextSlot); nextSlot = s + 150; if (s > now) await sleep(s - now); }
async function dartJson(build: (k: string) => string): Promise<Record<string, unknown> | null> {
  for (let attempt = 0; attempt <= 2;) {
    const k = pool.reserve();
    if (!k) return null;
    await slot();
    try {
      const res = await fetch(build(k.value));
      const text = await res.text();
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      const j = JSON.parse(text) as Record<string, unknown>;
      if (j.status === "020") { if (pool.on020(k.name)) continue; return null; }
      return j;
    } catch { if (attempt < 2) await sleep(1000 * 2 ** attempt); attempt++; }
  }
  return null;
}
const rowsOf = (j: Record<string, unknown> | null): Record<string, string>[] => ((j?.list as Record<string, string>[] | undefined) ?? []);
const fmtD = (d: string): string => (d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d || "-");
/** 본문 받기 + 실패 원인(HTTP 상태·content-type·앞 160자)을 함께 돌려준다. */
async function dartDoc(rceptNo: string): Promise<{ text: string | null; diag: string }> {
  const k = pool.reserve();
  if (!k) return { text: null, diag: "요청 상한" };
  await slot();
  try {
    const res = await fetch(`${BASE}/document.xml?crtfc_key=${k.value}&rcept_no=${rceptNo}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const ct = res.headers.get("content-type") ?? "-";
    let zip: AdmZip;
    try { zip = new AdmZip(buf); } catch { return { text: null, diag: `HTTP ${res.status} ${ct} ${buf.length}B zip 아님: ${buf.toString("utf8", 0, 160).replace(/crtfc_key=[^&\s"]*/g, "crtfc_key=***").replace(/\s+/g, " ")}` }; }
    const ents = zip.getEntries();
    if (!ents.length) return { text: null, diag: `HTTP ${res.status} ${ct} ${buf.length}B zip 항목 0개` };
    let text = new TextDecoder("utf-8").decode(ents[0].getData());
    if ((text.match(/�/g) ?? []).length > 20) text = new TextDecoder("euc-kr").decode(ents[0].getData());
    return { text: text.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/g, " ").replace(/\s+/g, " "), diag: `HTTP ${res.status} ${ct} ${buf.length}B 항목 ${ents.length}개(${ents.map((e) => e.entryName).slice(0, 3).join(",")})` };
  } catch (e) { return { text: null, diag: `예외 ${e instanceof Error ? e.message : String(e)}` }; }
}

async function main(): Promise<void> {
  const k3 = process.env.DART_API_KEY_3, k2 = process.env.DART_API_KEY_2;
  if (!k3 || !k2) throw new Error("DART_API_KEY_3, DART_API_KEY_2가 필요합니다.");
  pool = new DartKeyPool([{ name: "DART_API_KEY_3", value: k3 }, { name: "DART_API_KEY_2", value: k2 }], REQUEST_CAP);
  console.log(`L-0b DART 보완 점검(읽기 전용, 시험 아님) 시작: ${new Date().toISOString()} | 요청 상한 ${REQUEST_CAP} | 키 1순위 DART_API_KEY_3, 2순위 DART_API_KEY_2, 운영 키 미사용`);

  // ---- A. 임원·주요주주 소유보고 공시 목록 이력 (list.json, pblntf_ty=D, D002) ----
  console.log("\n=== A. 지분공시 D002(임원·주요주주 소유보고) 월 샘플 (유가증권시장 corp_cls=Y, 1페이지) ===\n| 월 | status | 총 건수 | 총 페이지 | 1페이지 행 수 | 보고서명 상위 | 접수번호 날짜 ≠ rcept_dt 행 |\n|---|---|---|---|---|---|---|");
  const docs: { ym: string; rcept_no: string; rcept_dt: string }[] = [];
  for (const [ym, bgn, end] of [["2010-10", "20101001", "20101031"], ["2015-10", "20151001", "20151031"], ["2020-10", "20201001", "20201031"], ["2025-10", "20251001", "20251031"]]) {
    const j = await dartJson((k) => `${BASE}/list.json?crtfc_key=${k}&bgn_de=${bgn}&end_de=${end}&corp_cls=Y&pblntf_ty=D&pblntf_detail_ty=D002&page_no=1&page_count=100`);
    const rs = rowsOf(j);
    const names = new Map<string, number>();
    for (const r of rs) names.set((r.report_nm ?? "").replace(/\s+/g, ""), (names.get((r.report_nm ?? "").replace(/\s+/g, "")) ?? 0) + 1);
    console.log(`| ${ym} | ${j ? String(j.status) : "요청 실패"} | ${j?.total_count ?? "-"} | ${j?.total_page ?? "-"} | ${rs.length} | ${[...names].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n, c]) => `${n} ${c}`).join(" / ") || "-"} | ${rs.filter((r) => (r.rcept_no ?? "").slice(0, 8) !== r.rcept_dt).length} |`);
    if ((ym === "2010-10" || ym === "2015-10") && rs[0]) docs.push({ ym, rcept_no: rs[0].rcept_no, rcept_dt: rs[0].rcept_dt });
  }
  console.log("\nA-2. 옛 소유보고 본문 샘플(변동일과 접수일 간격):");
  for (const dr of docs) {
    const { text, diag } = await dartDoc(dr.rcept_no);
    if (!text) { console.log(`- ${dr.ym} 접수 ${fmtD(dr.rcept_dt)}: 본문 받기 실패 — ${diag}`); continue; }
    const i = text.indexOf("변동일"), dm = i >= 0 ? text.slice(i, i + 220).match(/(\d{4})[-.\s년]+(\d{1,2})[-.\s월]+(\d{1,2})/) : null;
    const trade = dm ? `${dm[1]}-${dm[2].padStart(2, "0")}-${dm[3].padStart(2, "0")}` : null;
    console.log(`- ${dr.ym} 접수 ${fmtD(dr.rcept_dt)} 본문 ${text.length}자 | ${diag} | 변동일 근처: ${i >= 0 ? text.slice(i, i + 130) : "(변동일 못 찾음)"} | 처음 읽힌 날짜 ${trade ?? "-"} → 간격 ${trade ? Math.round((Date.parse(fmtD(dr.rcept_dt)) - Date.parse(trade)) / 86_400_000) : "-"}일`);
  }

  // ---- B. L-0에서 본문 받기에 실패한 두 건의 원인 ----
  console.log("\n=== B. 본문 받기 실패 원인 재확인 (단일판매 GS건설 2015-10, 전환사채 호전실업 2020-10) ===");
  for (const [label, stock, bgn, end, ty, re] of [["단일판매 GS건설", "006360", "20151001", "20151031", "I", /단일판매/], ["전환사채 호전실업", "111110", "20201001", "20201031", "B", /전환사채권발행결정/]] as const) {
    const { data } = await supabaseAdmin.from("dart_corp_codes").select("corp_code, corp_name").eq("stock_code", stock).limit(1);
    const corp = data?.[0]?.corp_code as string | undefined;
    if (!corp) { console.log(`- ${label}: corp_code 없음`); continue; }
    const j = await dartJson((k) => `${BASE}/list.json?crtfc_key=${k}&corp_code=${corp}&bgn_de=${bgn}&end_de=${end}&pblntf_ty=${ty}&page_no=1&page_count=100`);
    const hit = rowsOf(j).filter((r) => re.test((r.report_nm ?? "").replace(/\s+/g, "")));
    if (!hit.length) { console.log(`- ${label}: 해당 월 목록에서 대상 공시 못 찾음(목록 ${rowsOf(j).length}행, status ${j ? String(j.status) : "실패"})`); continue; }
    const { text, diag } = await dartDoc(hit[0].rcept_no);
    console.log(`- ${label} (${hit[0].report_nm}, 접수번호 날짜 ${fmtD(hit[0].rcept_no.slice(0, 8))}, rcept_dt ${fmtD(hit[0].rcept_dt)}): ${text ? `본문 ${text.length}자 받기 성공` : "본문 받기 실패"} | ${diag}${text ? ` | 앞부분: ${text.slice(0, 120)}` : ""}`);
  }

  // ---- C. 접수번호 날짜 ≠ rcept_dt 행 내용 (2025-10 B001) ----
  console.log("\n=== C. 접수번호 앞 8자리와 rcept_dt가 다른 행 (2025-10, B001, 유가증권시장) ===");
  for (let p = 1; p <= 2; p++) {
    const j = await dartJson((k) => `${BASE}/list.json?crtfc_key=${k}&bgn_de=20251001&end_de=20251031&corp_cls=Y&pblntf_ty=B&pblntf_detail_ty=B001&page_no=${p}&page_count=100`);
    for (const r of rowsOf(j).filter((x) => (x.rcept_no ?? "").slice(0, 8) !== x.rcept_dt)) console.log(`- 접수번호 ${r.rcept_no} (날짜 ${fmtD(r.rcept_no.slice(0, 8))}) / rcept_dt ${fmtD(r.rcept_dt)} / ${(r.report_nm ?? "").replace(/\s+/g, " ")} / 비고 ${r.rm ?? "-"} / ${r.corp_name}`);
  }
  console.log(`\nDART 요청 수: ${pool.total} (상한 ${REQUEST_CAP}) | 키별: ${[...pool.used].map(([n, v]) => `${n} ${v}`).join(", ")} | status 020: ${[...pool.got020].map(([n, v]) => `${n} ${v}`).join(", ")} | 중단 사유: ${pool.stopReason ?? "없음"}`);
  console.log(`Supabase 쓴 행: 0 | KIS·KRX 요청 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
