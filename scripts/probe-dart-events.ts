/**
 * [임시 점검 — 병합 금지, 읽기 전용, 저장 없음] DART 이벤트 공시 API(자기주식 취득 결정·신탁계약, 임원·주요주주 소유보고) 확보 가능성.
 * DART 요청 총 60건 이하(키 DART_API_KEY_3 → DART_API_KEY_2, 운영 키 금지, 키 값 출력 금지). DB는 dart_corp_codes 읽기만. 숫자와 표만 출력한다.
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadAllStockSeriesFromParquet } from "@/lib/stockDailyPricesStorage";
import { DartKeyPool } from "./dartKeyPool";

const T0 = Date.now();
const BASE = "https://opendart.fss.or.kr/api";
const REQUEST_CAP = 60;
const BGN = "20150101", END = "20261001";
const FIXED = ["005930", "000660", "035420"];
const MID_TARGETS_EOK = [7000, 15000];
const DELIST_FROM = "2015-01-01", DELIST_TO = "2020-12-31";
const WINDOW = { bgn: "20240801", end: "20241031" };
const DAILY_LIMIT = 20_000;
const MAX_CATEGORICAL = 12;
const MS_DAY = 86_400_000;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
let pool: DartKeyPool;
let nextSlot = 0;
async function slot(): Promise<void> { const now = Date.now(); const s = Math.max(now, nextSlot); nextSlot = s + 150; if (s > now) await sleep(s - now); }
async function dartJson(build: (k: string) => string): Promise<Record<string, unknown> | null> {
  for (let attempt = 0; attempt <= 2; ) {
    const k = pool.reserve();
    if (!k) return null;
    await slot();
    try {
      const res = await fetch(build(k.value));
      const text = await res.text();
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      const j = JSON.parse(text) as Record<string, unknown>;
      if (j.status === "020") { if (pool.on020(k.name)) continue; return null; }
      if (j.status === "800") throw new Error("800");
      return j;
    } catch { if (attempt < 2) await sleep(1000 * 2 ** attempt); attempt++; }
  }
  return null;
}
const toRows = (j: Record<string, unknown> | null): Record<string, string>[] => ((j?.list as Record<string, string>[] | undefined) ?? []);
const dateOf = (r: Record<string, string>): string => (r.rcept_dt ?? (r.rcept_no ?? "").slice(0, 8)) || "";
const fmtDate = (d: string): string => (d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d || "-");

async function main(): Promise<void> {
  const k3 = process.env.DART_API_KEY_3, k2 = process.env.DART_API_KEY_2;
  if (!k3 || !k2) throw new Error("DART_API_KEY_3, DART_API_KEY_2가 필요합니다.");
  pool = new DartKeyPool([{ name: "DART_API_KEY_3", value: k3 }, { name: "DART_API_KEY_2", value: k2 }], REQUEST_CAP);
  console.log(`DART 이벤트 공시 점검(읽기 전용) 시작: ${new Date().toISOString()} | 요청 상한 ${REQUEST_CAP} | 키 1순위 DART_API_KEY_3, 2순위 DART_API_KEY_2, 운영 키 미사용`);
  const dbRead: Record<string, number> = {};

  // ---- 종목 선정(가격 Parquet + dart_corp_codes) ----
  const series = await loadAllStockSeriesFromParquet(2014, new Date().getUTCFullYear());
  let globalLast = "";
  for (const rows of series.values()) { const l = rows[rows.length - 1]?.tradeDate ?? ""; if (l > globalLast) globalLast = l; }
  const aliveCut = new Date(Date.parse(globalLast) - 14 * MS_DAY).toISOString().slice(0, 10);
  const allCorp: { corp_code: string; corp_name: string; stock_code: string | null }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabaseAdmin.from("dart_corp_codes").select("corp_code, corp_name, stock_code").not("stock_code", "is", null).order("corp_code").range(from, from + 999);
    if (error) throw new Error(error.message);
    allCorp.push(...(data ?? []));
    dbRead.dart_corp_codes = (dbRead.dart_corp_codes ?? 0) + (data?.length ?? 0);
    if ((data?.length ?? 0) < 1000) break;
  }
  const corpBy = new Map<string, { corp: string; name: string }>();
  for (const c of allCorp) if (c.stock_code && !corpBy.has(c.stock_code)) corpBy.set(c.stock_code, { corp: c.corp_code, name: c.corp_name });
  const mcapAt2018 = (code: string): number | null => { const rows = series.get(code); if (!rows) return null; for (let i = rows.length - 1; i >= 0; i--) if (rows[i].tradeDate <= "2018-12-31") return rows[i].marketCapEok; return null; };
  const alive = [...series.entries()].filter(([c, r]) => corpBy.has(c) && !FIXED.includes(c) && r[r.length - 1].tradeDate >= aliveCut && r[0].tradeDate <= "2018-12-31" && (mcapAt2018(c) ?? 0) > 0);
  const mids: string[] = [];
  for (const target of MID_TARGETS_EOK) {
    const best = alive.filter(([c]) => !mids.includes(c)).sort((a, b) => Math.abs(mcapAt2018(a[0])! - target) - Math.abs(mcapAt2018(b[0])! - target))[0];
    if (best) mids.push(best[0]);
  }
  const dels = [...series.entries()].filter(([c, r]) => corpBy.has(c) && r[r.length - 1].tradeDate >= DELIST_FROM && r[r.length - 1].tradeDate <= DELIST_TO && r[r.length - 1].tradeDate < aliveCut).sort((a, b) => b[1][b[1].length - 1].marketCapEok - a[1][a[1].length - 1].marketCapEok);
  const del = dels[0]?.[0];
  const targets = [...FIXED, ...mids, ...(del ? [del] : [])];
  const labels = ["대형", "대형", "대형", "중형", "중형", "상장폐지"];
  console.log("\n=== 대상 종목 ===\n| 구분 | 코드 | 회사 | corp_code | 마지막 거래일 | 2018말 시총(억) |\n|---|---|---|---|---|---|");
  targets.forEach((c, i) => console.log(`| ${labels[i]} | ${c} | ${corpBy.get(c)?.name ?? "-"} | ${corpBy.get(c)?.corp ?? "-"} | ${series.get(c)?.[series.get(c)!.length - 1].tradeDate ?? "-"} | ${mcapAt2018(c)?.toFixed(0) ?? "-"} |`));

  const apis: { id: string; label: string; path: string }[] = [
    { id: "1", label: "자기주식 취득 결정", path: "tsstkAqDecsn.json" },
    { id: "2", label: "자기주식 취득 신탁계약 체결 결정", path: "tsstkAqTrctrCnsDecsn.json" },
    { id: "3", label: "임원·주요주주 소유보고", path: "elestock.json" },
  ];
  for (const api of apis) {
    console.log(`\n=== ${api.id}. ${api.label} (${api.path}), 조회 ${fmtDate(BGN)}~${fmtDate(END)} ===`);
    console.log("| 종목 | status | message | 건수 | 가장 이른 접수일 | 가장 늦은 접수일 |\n|---|---|---|---|---|---|");
    const keyCount = new Map<string, number>();
    const vals = new Map<string, Map<string, number>>();
    let sample: Record<string, string> | null = null, sampleCode = "";
    const all: Record<string, string>[] = [];
    let keysSeen: string[] = [];
    for (const code of targets) {
      const corp = corpBy.get(code)?.corp;
      if (!corp) continue;
      const j = await dartJson((k) => `${BASE}/${api.path}?crtfc_key=${k}&corp_code=${corp}&bgn_de=${BGN}&end_de=${END}`);
      const rows = toRows(j);
      const ds = rows.map(dateOf).filter(Boolean).sort();
      console.log(`| ${code} | ${j ? String(j.status) : "요청 실패"} | ${j ? String(j.message ?? "") : "-"} | ${rows.length} | ${ds.length ? fmtDate(ds[0]) : "-"} | ${ds.length ? fmtDate(ds[ds.length - 1]) : "-"} |`);
      for (const r of rows) {
        all.push(r);
        for (const [kk, vv] of Object.entries(r)) {
          keyCount.set(kk, (keyCount.get(kk) ?? 0) + 1);
          (vals.get(kk) ?? vals.set(kk, new Map()).get(kk)!).set(vv, ((vals.get(kk)!.get(vv)) ?? 0) + 1);
        }
        if (!sample) { sample = r; sampleCode = code; }
      }
      if (rows.length && !keysSeen.length) keysSeen = Object.keys(rows[0]);
    }
    if (!all.length) { console.log("(응답 행이 없어 필드명을 확인하지 못함)"); continue; }
    console.log(`\n필드명(${keysSeen.length}개) — 전체 응답 ${all.length}행 기준:`);
    console.log("| 필드 | 값이 있는 행 수 | 서로 다른 값 수 | 범주형이면 값(건수) | 예시 값 |\n|---|---|---|---|---|");
    for (const kk of keysSeen) {
      const vm = vals.get(kk) ?? new Map<string, number>();
      const nonEmpty = [...vm.entries()].filter(([v]) => v !== "" && v !== "-").reduce((a, [, n]) => a + n, 0);
      const cat = vm.size <= MAX_CATEGORICAL ? [...vm.entries()].sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v || "(빈값)"}(${n})`).join(", ") : "-";
      console.log(`| ${kk} | ${nonEmpty} | ${vm.size} | ${cat} | ${sample ? String(sample[kk] ?? "").slice(0, 40) : ""} |`);
    }
    if (api.id === "3") {
      const incKeys = keysSeen.filter((k) => /irds|증감/i.test(k));
      for (const k of incKeys) {
        const nums = all.map((r) => Number((r[k] ?? "").replace(/,/g, ""))).filter((n) => Number.isFinite(n));
        console.log(`증감 필드 ${k}: 양수 ${nums.filter((n) => n > 0).length} / 음수 ${nums.filter((n) => n < 0).length} / 0 ${nums.filter((n) => n === 0).length} (숫자 ${nums.length}행)`);
      }
      const reasonKeys = keysSeen.filter((k) => /reason|rsn|cause|resn|사유|mth|type|se$/i.test(k));
      console.log(`취득·처분 사유/방법을 담을 만한 필드명(이름 패턴 /reason|rsn|cause|사유|mth|type/): ${reasonKeys.length ? reasonKeys.join(", ") : "없음"}`);
    }
    console.log(`예시 1행(${sampleCode}): ${JSON.stringify(sample).slice(0, 700)}`);
  }

  // ---- 4. list.json 시장 단위 ----
  console.log("\n=== 4. 공시검색(list.json) — 시장 단위 조회 ===");
  console.log("| 조회 | 파라미터 | status | message | page_no | total_page | total_count | 1페이지 행 수 | 1페이지 중 '자기주식' 포함 report_nm |\n|---|---|---|---|---|---|---|---|---|");
  const trial = [
    { name: "(a) 전체 기간(corp_code 없음)", q: `bgn_de=${BGN}&end_de=${END}&pblntf_ty=B&pblntf_detail_ty=B001&page_no=1&page_count=100` },
    { name: "(b) 3개월 창, 상세유형 B001", q: `bgn_de=${WINDOW.bgn}&end_de=${WINDOW.end}&pblntf_ty=B&pblntf_detail_ty=B001&page_no=1&page_count=100` },
    { name: "(c) 3개월 창, 대분류 B만", q: `bgn_de=${WINDOW.bgn}&end_de=${WINDOW.end}&pblntf_ty=B&page_no=1&page_count=100` },
  ];
  const tp: Record<string, number> = {};
  const names = new Set<string>();
  for (const t of trial) {
    const j = await dartJson((k) => `${BASE}/list.json?crtfc_key=${k}&${t.q}`);
    const rows = toRows(j);
    const own = rows.filter((r) => /자기주식/.test(r.report_nm ?? ""));
    for (const r of own) names.add((r.report_nm ?? "").replace(/\s+/g, " "));
    if (j && typeof j.total_page === "number") tp[t.name] = j.total_page as number;
    console.log(`| ${t.name} | ${t.q.replace(/page_count=100/, "page_count=100")} | ${j ? String(j.status) : "요청 실패"} | ${j ? String(j.message ?? "") : "-"} | ${j?.page_no ?? "-"} | ${j?.total_page ?? "-"} | ${j?.total_count ?? "-"} | ${rows.length} | ${own.length} |`);
  }
  console.log(`1페이지에서 보인 '자기주식' 포함 보고서명: ${names.size ? [...names].slice(0, 8).join(" / ") : "없음"}`);
  console.log("list.json 요청 변수에 보고서명(report_nm) 검색 파라미터는 없음(문서상 corp_code, bgn_de, end_de, last_reprt_at, pblntf_ty, pblntf_detail_ty, corp_cls, sort, sort_mth, page_no, page_count) — 시장 단위 이벤트 탐색은 위 분류로 받은 페이지에서 report_nm을 필터해야 함.");

  // ---- 5. 규모 추정 ----
  const stocks = 1094;
  console.log("\n=== 5. 규모 추정 ===");
  console.log("| 방식 | 계산 | 요청 수 | 하루 한도 20,000 대비 일수 |\n|---|---|---|---|");
  console.log(`| 종목별 API 3종 (종목당 API당 1회, 기간 전체 한 번에 응답) | ${stocks} × 3 | ${stocks * 3} | ${(stocks * 3 / DAILY_LIMIT).toFixed(2)} |`);
  console.log(`| 위 + 응답이 잘려 재요청이 필요한 경우 상한(×2) | ${stocks} × 3 × 2 | ${stocks * 6} | ${(stocks * 6 / DAILY_LIMIT).toFixed(2)} |`);
  const days = Math.ceil((Date.parse("2026-10-01") - Date.parse("2015-01-01")) / MS_DAY);
  const windows = Math.ceil(days / 92);
  const pagesB = tp["(b) 3개월 창, 상세유형 B001"];
  console.log(`| 시장 단위 list.json (B001, 3개월 창) | 창 ${windows}개(${days}일/92일) × 창당 ${pagesB ?? "?"}페이지(표본 창 기준) | ${pagesB ? windows * pagesB : "-"} | ${pagesB ? (windows * pagesB / DAILY_LIMIT).toFixed(3) : "-"} |`);

  console.log("\n=== 실행 지표 ===");
  console.log(`DART 요청 수: ${pool.total} (상한 ${REQUEST_CAP}) | 키별: ${[...pool.used].map(([n, v]) => `${n} ${v}`).join(", ")} | status 020: ${[...pool.got020].map(([n, v]) => `${n} ${v}`).join(", ")}`);
  console.log(`Supabase 읽은 행: ${Object.entries(dbRead).map(([k, v]) => `${k} ${v}`).join(" | ")} | Supabase 쓴 행: 0 | KIS 요청: 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
