/**
 * [임시 연구 — 병합 금지] 연구 PEAD 잠정실적 공정공시 파일럿 2차(시험 아님, 시도 번호 소진 없음): (1) 1차 파일럿 14건(코스피)에서 자동 추출한 영업이익 값을 같은 기업·분기의 정기보고서 값(DART 단일회사 주요계정 API)과 대조
 * (2) 접수 시각처럼 보이는 문구의 문맥 확인(원문 3건 다시 받음) (3) 코스닥 원문 3건 파일럿. 원문은 저장하지 않는다. Storage 읽기·쓰기 0(재무 Parquet을 읽지 않는다), 연구 DB는 dart_corp_codes 읽기만.
 * DART 연구용 키(DART_API_KEY_2/_3)만 쓴다. 호출 수는 PEAD_PRELIM.callCap(1차 실행 96건 포함 합계 기준 150) 이내로 제한한다.
 */
import AdmZip from "adm-zip";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { PEAD_PRELIM as P } from "@/lib/peadConfig";
import { f2 } from "./researchHarness";

const BASE = "https://opendart.fss.or.kr/api";
const PRIOR_CALLS = 96;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const keys = [{ name: "DART_API_KEY_2", value: process.env.DART_API_KEY_2 ?? "", off: false, used: 0 }, { name: "DART_API_KEY_3", value: process.env.DART_API_KEY_3 ?? "", off: false, used: 0 }];
let calls = 0;
const pickKey = (): (typeof keys)[number] => {
  if (PRIOR_CALLS + calls >= P.callCap) throw new Error(`DART 호출 상한 ${P.callCap}건에 도달(1차 ${PRIOR_CALLS} + 이번 ${calls})`);
  const k = keys.filter((x) => !x.off && x.value).sort((a, b) => a.used - b.used)[0];
  if (!k) throw new Error("사용 가능한 연구용 DART 키가 없음");
  k.used++; calls++;
  return k;
};
async function api<T>(path: string, params: Record<string, string | number>): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const k = pickKey();
    await sleep(P.gapMs);
    const res = await fetch(`${BASE}/${path}?${new URLSearchParams({ crtfc_key: k.value, ...Object.fromEntries(Object.entries(params).map(([a, b]) => [a, String(b)])) })}`);
    const j = (await res.json()) as { status: string; message: string } & T;
    if (j.status === "020") { k.off = true; continue; }
    if (j.status !== "000" && j.status !== "013") throw new Error(`${path} 오류 status ${j.status} ${j.message}`);
    return j;
  }
  throw new Error(`${path} 연구용 키 한도`);
}
async function docText(rcept: string): Promise<{ text: string; bytes: number }> {
  const k = pickKey();
  await sleep(P.gapMs);
  const res = await fetch(`${BASE}/document.xml?${new URLSearchParams({ crtfc_key: k.value, rcept_no: rcept })}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf[0] !== 0x50 || buf[1] !== 0x4b) throw new Error(`${rcept}: zip 아님 ${buf.toString("utf8").slice(0, 100)}`);
  const ent = new AdmZip(buf).getEntries().filter((e) => !e.isDirectory)[0].getData();
  const u = ent.toString("utf8");
  const raw = (u.match(/�/g) ?? []).length < 5 ? u : new TextDecoder("euc-kr").decode(ent);
  const text = raw.replace(/<\/(TD|TH|TE|TU)\s*>/gi, " | ").replace(/<\/(TR|P|BR|TITLE|SECTION-\d|TABLE|LIBRARY)\s*>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/[ \t ]+/g, " ");
  return { text, bytes: buf.byteLength };
}

const numOf = (s: string): number | null => {
  const t = s.replace(/[\s,+%]/g, "");
  const m = /^([(△▲\-－]?)(\d+(?:\.\d+)?)\)?$/.exec(t);
  return m ? (m[1] ? -Number(m[2]) : Number(m[2])) : null;
};
interface Parsed { unit: string; scale: number; cons: boolean | null; year: number | null; q: number | null; cur: number | null; prevY: number | null; cols: string[]; cells: string[]; reason: string }
/** 영업(잠정)실적 공정공시 표 파서: 셀 토큰 열에서 '영업이익' '당해실적' 다음 값들을 헤더에 맞춰 읽는다(흑자적자전환여부 열이 있으면 증감율 뒤에 한 칸씩 더). */
function parse(text: string): Parsed {
  const tk = text.split(/[\n|]/).map((x) => x.trim()).filter(Boolean);
  const um = /단위\s*[:：]?\s*(백만원|천원|억원|원)/.exec(text);
  const unit = um?.[1] ?? "불명", scale = unit === "백만원" ? 1e6 : unit === "천원" ? 1e3 : unit === "억원" ? 1e8 : unit === "원" ? 1 : NaN;
  const i0 = Math.max(tk.findIndex((x) => x.startsWith("구분")), 0), im = tk.indexOf("매출액");
  const hdr = im > i0 ? tk.slice(i0 + 1, im) : [];
  const hasFlag = hdr.some((x) => x.includes("흑자적자"));
  const cols = ["cur", "prevQ", "pctQ", ...(hasFlag ? ["flag"] : []), "prevY", "pctY", ...(hasFlag ? ["flag"] : [])];
  const lab = hdr.map((x) => /(\d{4}|\d{2})\s*(?:년|\.)?\s*(\d)\s*(?:분기|Q)/i.exec(x)).find(Boolean);
  const year = lab ? (lab[1].length === 2 ? 2000 + Number(lab[1]) : Number(lab[1])) : null, q = lab ? Number(lab[2]) : null;
  const ii = tk.findIndex((x, i) => x === "영업이익" && tk[i + 1] === "당해실적");
  let cells: string[] = [], reason = "";
  if (ii < 0) reason = "영업이익 행 없음";
  else { for (const y of tk.slice(ii + 2, ii + 2 + 14)) { if (y === "누계실적") break; cells.push(y); } if (cells.length !== cols.length) reason = `값 칸 수 ${cells.length} ≠ 헤더 열 수 ${cols.length}`; }
  const at = (n: string, k = 0): number | null => { const idx = cols.map((c, i) => (c === n ? i : -1)).filter((i) => i >= 0)[k]; return idx !== undefined && cells[idx] !== undefined ? numOf(cells[idx]) : null; };
  if (reason) cells = cells.slice(0, 12);
  return { unit, scale, cons: /연결/.test(text.slice(0, 600)) ? true : null, year, q, cur: reason ? null : at("cur"), prevY: reason ? null : at("prevY"), cols, cells, reason };
}

// 1차 파일럿(run 40464190637)에서 원문 발췌를 보고 같은 규칙으로 읽은 값(단위 그대로). 종목코드는 기업 식별용.
interface Pre { n: number; code: string; name: string; rno: string; cons: boolean; year: number; q: number; unit: string; cur: number; prevY: number }
const PRE: Pre[] = [
  { n: 1, code: "011780", name: "금호석유화학", rno: "20230804800168", cons: true, year: 2023, q: 2, unit: "백만원", cur: 107923, prevY: 353951 },
  { n: 2, code: "011780", name: "금호석유화학", rno: "20190802800347", cons: true, year: 2019, q: 2, unit: "백만원", cur: 138941, prevY: 153502 },
  { n: 3, code: "007690", name: "국도화학", rno: "20200717800158", cons: true, year: 2020, q: 2, unit: "백만원", cur: 15408, prevY: 10344 },
  { n: 4, code: "021240", name: "코웨이", rno: "20181030800476", cons: true, year: 2018, q: 3, unit: "백만원", cur: 130356, prevY: 124163 },
  { n: 5, code: "011780", name: "금호석유화학", rno: "20220504800203", cons: true, year: 2022, q: 1, unit: "백만원", cur: 449068, prevY: 612520 },
  { n: 6, code: "001120", name: "LX인터내셔널", rno: "20210430800213", cons: true, year: 2021, q: 1, unit: "억원", cur: 1133, prevY: 499 },
  { n: 7, code: "009180", name: "한솔로지스틱스", rno: "20260729800855", cons: true, year: 2026, q: 2, unit: "백만원", cur: 6118, prevY: 6405 },
  { n: 8, code: "234080", name: "JW생명과학", rno: "20240802800278", cons: false, year: 2024, q: 2, unit: "백만원", cur: 8424, prevY: 7596 },
  { n: 9, code: "192080", name: "더블유게임즈", rno: "20250212800016", cons: true, year: 2024, q: 4, unit: "백만원", cur: 60508, prevY: 62840 },
  { n: 10, code: "033780", name: "케이티앤지", rno: "20170119800060", cons: true, year: 2016, q: 4, unit: "백만원", cur: 304949, prevY: 263852 },
  { n: 11, code: "068270", name: "셀트리온", rno: "20201109800276", cons: true, year: 2020, q: 3, unit: "백만원", cur: 245274, prevY: 103149 },
  { n: 12, code: "036570", name: "NC", rno: "20190802800010", cons: true, year: 2019, q: 2, unit: "백만원", cur: 129407, prevY: 159511 },
  { n: 13, code: "267250", name: "HD현대", rno: "20230427800350", cons: true, year: 2023, q: 1, unit: "억원", cur: 6109, prevY: 8050 },
  { n: 14, code: "001440", name: "대한전선", rno: "20200720800088", cons: false, year: 2020, q: 2, unit: "백만원", cur: 20924, prevY: 2322 },
];
interface AcntRow { fs_div: string; account_nm: string; thstrm_amount?: string; frmtrm_amount?: string; thstrm_add_amount?: string; frmtrm_add_amount?: string }
const RC: Record<number, string> = { 1: "11013", 2: "11012", 3: "11014", 4: "11011" };
const amt = (s?: string): number | null => { const v = Number((s ?? "").replace(/,/g, "")); return s && Number.isFinite(v) && s.trim() !== "" ? v : null; };

async function main(): Promise<void> {
  console.log(`연구 PEAD 잠정실적 파일럿 2차 시작(시험 아님): ${new Date().toISOString()} | 키 ${keys.filter((x) => x.value).length}개(값 비출력)`);
  if (keys.some((k) => !k.value)) throw new Error("DART_API_KEY_2, DART_API_KEY_3가 필요합니다.");
  const { data, error } = await supabaseAdmin.from("dart_corp_codes").select("corp_code, corp_name, stock_code").in("stock_code", [...new Set(PRE.map((x) => x.code))]);
  if (error) throw new Error(error.message);
  const corpOf = new Map((data ?? []).map((r) => [String(r.stock_code), String(r.corp_code)]));
  console.log(`dart_corp_codes 조회 ${data?.length ?? 0}행(읽기만): ${PRE.map((x) => `${x.name}→${corpOf.get(x.code) ? "O" : "X"}`).join(", ")}`);

  // ---- (1) 정기보고서 값과 대조 ----
  const singl = async (corp: string, y: number, rc: string): Promise<AcntRow[]> => ((await api<{ list?: AcntRow[] }>("fnlttSinglAcnt.json", { corp_code: corp, bsns_year: y, reprt_code: rc })).list ?? []).filter((r) => r.account_nm === "영업이익");
  const scaleOf = (u: string): number => (u === "백만원" ? 1e6 : u === "억원" ? 1e8 : u === "천원" ? 1e3 : 1);
  console.log(`\n=== 2-1. 잠정실적 파싱 값 vs 정기보고서 값(DART 단일회사 주요계정 API, 연결=CFS·별도=OFS) — 원 단위 비교, 허용오차 = 잠정실적 표기 단위 ===\n| # | 기업 | 잠정실적 접수일 대상 분기 | 연결 | 단위 | 잠정실적 당기 / 전년동기 | 정기보고서 당기 / 전년동기 (원) | 일치 |\n|---|---|---|---|---|---|---|---|`);
  let nOk = 0, nCmp = 0;
  for (const p of PRE) {
    const corp = corpOf.get(p.code);
    if (!corp) { console.log(`| ${p.n} | ${p.name} | ${p.year}Q${p.q} | - | - | - | corp_code 없음 | - |`); continue; }
    const fs = p.cons ? "CFS" : "OFS";
    let cur: number | null = null, prev: number | null = null;
    if (p.q < 4) {
      const r = (await singl(corp, p.year, RC[p.q])).find((x) => x.fs_div === fs);
      cur = amt(r?.thstrm_amount); prev = amt(r?.frmtrm_amount);
    } else {
      const fy = (await singl(corp, p.year, "11011")).find((x) => x.fs_div === fs), q3 = (await singl(corp, p.year, "11014")).find((x) => x.fs_div === fs);
      const f = amt(fy?.thstrm_amount), fp = amt(fy?.frmtrm_amount), n9 = amt(q3?.thstrm_add_amount), n9p = amt(q3?.frmtrm_add_amount);
      cur = f !== null && n9 !== null ? f - n9 : null; prev = fp !== null && n9p !== null ? fp - n9p : null;
    }
    const sc = scaleOf(p.unit), tol = sc * 1.01;
    const ok = cur !== null && prev !== null && Math.abs(p.cur * sc - cur) <= tol && Math.abs(p.prevY * sc - prev) <= tol;
    if (cur !== null && prev !== null) { nCmp++; if (ok) nOk++; }
    console.log(`| ${p.n} | ${p.name} | ${p.year}년 ${p.q}분기${p.q === 4 ? "(= 연간 − 3분기 누적)" : ""} | ${p.cons ? "연결" : "별도"} | ${p.unit} | ${p.cur} / ${p.prevY} | ${cur ?? "-"} / ${prev ?? "-"} | ${cur === null || prev === null ? "비교 불가" : ok ? "일치" : `불일치(차 ${f2((p.cur * sc - cur) / sc)} / ${f2((p.prevY * sc - prev) / sc)} ${p.unit})`} |`);
  }
  console.log(`비교 가능 ${nCmp}건 중 일치 ${nOk}건 (${f2((nOk / Math.max(nCmp, 1)) * 100)}%)`);

  // ---- (2) 시각 문구 문맥 ----
  console.log(`\n=== 2-2. 접수 시각처럼 보인 문구의 문맥 (원문 3건 다시 받음) ===`);
  const ctxDocs = ["20170119800060", "20190802800010", "20230427800350"];
  let docs = 0, bytes = 0;
  for (const rno of ctxDocs) {
    const { text, bytes: b } = await docText(rno); docs++; bytes += b;
    const ms = [...text.matchAll(/(\d{1,2}\s*:\s*\d{2}|\d{1,2}\s*시\s*\d{0,2}\s*분?)/g)];
    console.log(`${rno} (zip ${b} B): ${ms.length ? ms.slice(0, 4).map((m) => `「${text.slice(Math.max(0, (m.index ?? 0) - 90), (m.index ?? 0) + 40).replace(/\s*\n\s*/g, " ⏎ ")}」`).join(" ") : "시각 문구 없음"}`);
    const head = text.replace(/\s*\n\s*/g, " ⏎ ").slice(0, 400);
    console.log(`    문서 머리: ${head}`);
  }

  // ---- (3) 코스닥 원문 3건 ----
  console.log(`\n=== 2-3. 코스닥 파일럿 (corp_cls=K, 실적 시즌 좁은 창에서 영업(잠정)실적 비정정 공시 앞쪽 3건 이내) ===`);
  interface Row { corp_code: string; corp_name: string; report_nm: string; rcept_no: string; rcept_dt: string }
  const wins: [string, string][] = [["20200805", "20200814"], ["20230420", "20230515"], ["20250423", "20250515"]];
  let kDocs = 0, kOk = 0;
  for (const [a, b] of wins) {
    const r = await api<{ list?: Row[]; total_count?: number }>("list.json", { bgn_de: a, end_de: b, corp_cls: "K", pblntf_ty: "I", page_count: 100, page_no: 1, sort: "date", sort_mth: "asc" });
    const hit = (r.list ?? []).find((x) => x.report_nm.includes(P.keyword) && !x.report_nm.includes("정정"));
    if (!hit) { console.log(`창 ${a}~${b}: 전체 ${r.total_count ?? 0}건, 첫 100건 안에 영업(잠정)실적 없음`); continue; }
    const { text, bytes: bb } = await docText(hit.rcept_no); docs++; kDocs++; bytes += bb;
    const ps = parse(text);
    const corp = hit.corp_code;
    let cmp = "비교 불가(기간 판독 불가)";
    if (ps.year && ps.q && ps.cur !== null && ps.prevY !== null && Number.isFinite(ps.scale)) {
      const fs = ps.cons ? "CFS" : "OFS";
      let cur: number | null = null, prev: number | null = null;
      if (ps.q < 4) { const rr = (await singl(corp, ps.year, RC[ps.q])).find((x) => x.fs_div === fs); cur = amt(rr?.thstrm_amount); prev = amt(rr?.frmtrm_amount); }
      if (cur !== null && prev !== null) { const ok = Math.abs(ps.cur * ps.scale - cur) <= ps.scale * 1.01 && Math.abs(ps.prevY * ps.scale - prev) <= ps.scale * 1.01; if (ok) kOk++; cmp = `정기보고서 ${cur} / ${prev} → ${ok ? "일치" : "불일치"}`; }
    }
    console.log(`${hit.rcept_dt} ${hit.corp_name} ${hit.report_nm.replace(/\s+/g, " ")} (${hit.rcept_no}): zip ${bb} B | 단위 ${ps.unit} | 기간 ${ps.year ?? "?"}년 ${ps.q ?? "?"}분기 | ${ps.reason || "행 파싱 성공"} | 값 칸 ${ps.cells.join(" / ")} | 파싱 당기 ${ps.cur ?? "-"} / 전년동기 ${ps.prevY ?? "-"} | ${cmp}`);
  }
  console.log(`\n이번 실행 원문 ${docs}건(합계 ${bytes} B, 1차 14건과 합쳐 파일럿 원문 호출 ${14 + docs}건), 코스닥 ${kDocs}건 중 정기보고서와 일치 ${kOk}건 | DART 호출 이번 ${calls}건(1차 ${PRIOR_CALLS}건 포함 합계 ${PRIOR_CALLS + calls}건; 키별 ${keys.map((x) => `${x.name} ${x.used}`).join(", ")}) | Supabase 쓴 행 0 | Storage 읽기·쓰기 0 | 가격 성과 계산 없음 | 시도 번호 소진 없음`);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });
