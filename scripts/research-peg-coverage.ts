/**
 * [임시 점검 — 병합 금지, 읽기 전용, 외부 요청 0건, 저장 없음] peg 신호 커버리지 점검.
 * 월말 PIT 유니버스 구성원-월마다 lib/pegRatio.ts·lib/backtest.ts와 같은 규칙으로 5년 EPS CAGR이 계산되는지 센다.
 * 재무: FY2010~2014는 dart_xbrl_fundamentals(ni_parent, rcept_dt, cons→CFS / sep→OFS, FY2010은 prior_col),
 * FY2015~는 stock_annual_fundamentals(같은 (종목, 연도)에 둘 다 있으면 stock_annual_fundamentals 우선).
 * 탈락 사유 우선순위: 1 end 행 없음 2 start 행 없음 3 순이익 null 4 주식수 null 5 fs_div 불일치 6 적자 7 역성장.
 * 주식수: 공시일 기준 10일 룩백(DEFAULT_ON_OR_BEFORE_LOOKBACK_DAYS), 액면분할 등 조정 적용(research-audit-peg.ts:457와 동일).
 * 정의(스크립트 실행 전에 고정): 행이 "있다" = rcept 날짜가 있는 행(no_report 행은 없음으로 본다). DB는 REST 읽기만.
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadAllStockSeriesFromParquet, DEFAULT_ON_OR_BEFORE_LOOKBACK_DAYS, type StockDailyPriceRow } from "@/lib/stockDailyPricesStorage";
import { loadAppliedAdjustments } from "@/lib/stockPriceAdjustmentsStorage";
import { computeTrailingAvgTradingValue, pickListedSharesOnOrBefore } from "@/lib/pitUniverse";
import { PIT_LIQUIDITY_LOOKBACK_DAYS, PIT_MIN_AVG_TRADING_VALUE_WON } from "@/lib/strategyBacktestSummaryConfig";
import { PEG_GROWTH_LOOKBACK_YEARS } from "@/lib/pegConfig";
import { XBRL_BACKFILL_UNIVERSE_MIN_CAP_EOK, XBRL_BACKFILL_PIT_FROM, XBRL_BACKFILL_DB_IN_CHUNK, FIN_NAME_RE } from "@/lib/dartXbrlBackfillConfig";

const SEG_FROM = "2016-03-01";
const BASE_FROM = "2021-03-01";
const FY_FILL_FROM = 2015;
const FY_FILL_TO = 2020;
const T0 = Date.now();
const dbRead: Record<string, number> = {};
const pc = (a: number, b: number): string => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");

async function selectAll<T>(label: string, build: (f: number, t: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from, from + 999);
    if (error) throw new Error(`${label}: ${error.message}`);
    out.push(...(data ?? []));
    dbRead[label] = (dbRead[label] ?? 0) + (data?.length ?? 0);
    if ((data?.length ?? 0) < 1000) break;
  }
  return out;
}

interface Ann { fy: number; rcept: string; ni: number | null; fsDiv: string | null; src: "stock" | "xbrl" }
type Reason = 1 | 2 | 3 | 4 | 5 | 6 | 7;
const REASON_NAME: Record<Reason, string> = { 1: "end 행 없음", 2: "start 행 없음", 3: "순이익 null", 4: "주식수 null", 5: "fs_div 불일치", 6: "적자", 7: "역성장" };
interface MM { code: string; date: string; seg: "ext" | "base"; year: number; group: string; reason: Reason | null; missFy: number | null }

async function main(): Promise<void> {
  console.log(`peg 신호 커버리지 점검 시작(읽기 전용): ${new Date().toISOString()}`);
  const adjustments = await loadAppliedAdjustments();
  dbRead["stock_price_adjustment_events(applied)"] = [...adjustments.values()].reduce((a, l) => a + l.length, 0);
  console.log(`조정계수 적용 대상: ${adjustments.size}종목`);
  const series: Map<string, StockDailyPriceRow[]> = await loadAllStockSeriesFromParquet(2010, 2026, adjustments);
  let dataEnd = "";
  const lastTrade = new Map<string, string>();
  for (const [code, rows] of series) { const l = rows[rows.length - 1].tradeDate; lastTrade.set(code, l); if (l > dataEnd) dataEnd = l; }
  console.log(`종목 ${series.size}개 로드, 데이터 끝 ${dataEnd}`);

  // ---- 월말 PIT 구성원 ----
  const dates = new Set<string>();
  for (const rows of series.values()) for (const r of rows) if (r.tradeDate >= XBRL_BACKFILL_PIT_FROM) dates.add(r.tradeDate);
  const cal = [...dates].sort();
  const monthEnds = new Set<string>();
  for (let k = 0; k + 1 < cal.length; k++) if (cal[k].slice(0, 7) !== cal[k + 1].slice(0, 7)) monthEnds.add(cal[k]);
  const members = new Map<string, string[]>(); // date -> codes
  const everMember = new Set<string>();
  for (const [code, rows] of series) {
    const tv = computeTrailingAvgTradingValue(rows, PIT_LIQUIDITY_LOOKBACK_DAYS);
    for (let i = 1; i < rows.length; i++) {
      const d = rows[i].tradeDate;
      if (d < XBRL_BACKFILL_PIT_FROM || !monthEnds.has(d)) continue;
      if (rows[i - 1].marketCapEok >= XBRL_BACKFILL_UNIVERSE_MIN_CAP_EOK && tv[i] >= PIT_MIN_AVG_TRADING_VALUE_WON) {
        members.set(d, [...(members.get(d) ?? []), code]);
        everMember.add(code);
      }
    }
  }
  const codes = [...everMember].sort();
  console.log(`월말 ${monthEnds.size}개, PIT 진입 고유 종목 ${codes.length}개`);

  // ---- DB 읽기(REST) ----
  const corpMap = new Map<string, { corp: string; name: string }>();
  for (let i = 0; i < codes.length; i += XBRL_BACKFILL_DB_IN_CHUNK) {
    const chunk = codes.slice(i, i + XBRL_BACKFILL_DB_IN_CHUNK);
    const rs = await selectAll<{ corp_code: string; corp_name: string; stock_code: string | null }>("dart_corp_codes", (f, t) => supabaseAdmin.from("dart_corp_codes").select("corp_code, corp_name, stock_code").in("stock_code", chunk).order("corp_code").range(f, t));
    for (const r of rs) if (r.stock_code && !corpMap.has(r.stock_code)) corpMap.set(r.stock_code, { corp: r.corp_code, name: r.corp_name });
  }
  const stockRows = new Map<string, Ann[]>();
  for (let i = 0; i < codes.length; i += XBRL_BACKFILL_DB_IN_CHUNK / 2) {
    const chunk = codes.slice(i, i + XBRL_BACKFILL_DB_IN_CHUNK / 2);
    const rs = await selectAll<{ stock_code: string; fiscal_year: number; rcept_date: string; net_income_parent: number | null; fs_div: string }>("stock_annual_fundamentals", (f, t) => supabaseAdmin.from("stock_annual_fundamentals").select("stock_code, fiscal_year, rcept_date, net_income_parent, fs_div").in("stock_code", chunk).order("stock_code").order("fiscal_year").range(f, t));
    for (const r of rs) stockRows.set(r.stock_code, [...(stockRows.get(r.stock_code) ?? []), { fy: r.fiscal_year, rcept: r.rcept_date, ni: r.net_income_parent === null ? null : Number(r.net_income_parent), fsDiv: r.fs_div, src: "stock" }]);
  }
  const xbrlAnn = new Map<string, Ann[]>();
  const xbrlNoReport = new Map<string, Set<number>>(); // stock -> FY with status no_report
  const xbrlKeys = new Map<string, number>(); // stock -> 행 수
  const corpCodes = codes.filter((c) => corpMap.has(c)).map((c) => corpMap.get(c)!.corp);
  for (let i = 0; i < corpCodes.length; i += XBRL_BACKFILL_DB_IN_CHUNK / 2) {
    const chunk = corpCodes.slice(i, i + XBRL_BACKFILL_DB_IN_CHUNK / 2);
    const rs = await selectAll<{ stock_code: string; fiscal_year: number; rcept_dt: string | null; ni_parent: number | null; ni_basis: string | null; status: string }>("dart_xbrl_fundamentals", (f, t) => supabaseAdmin.from("dart_xbrl_fundamentals").select("stock_code, fiscal_year, rcept_dt, ni_parent, ni_basis, status").in("corp_code", chunk).order("corp_code").order("fiscal_year").order("source").range(f, t));
    for (const r of rs) {
      xbrlKeys.set(r.stock_code, (xbrlKeys.get(r.stock_code) ?? 0) + 1);
      if (r.status === "no_report") { const s = xbrlNoReport.get(r.stock_code) ?? new Set(); s.add(r.fiscal_year); xbrlNoReport.set(r.stock_code, s); }
      if (!r.rcept_dt) continue;
      xbrlAnn.set(r.stock_code, [...(xbrlAnn.get(r.stock_code) ?? []), { fy: r.fiscal_year, rcept: r.rcept_dt, ni: r.ni_parent === null ? null : Number(r.ni_parent), fsDiv: r.ni_basis === "cons" ? "CFS" : r.ni_basis === "sep" ? "OFS" : r.ni_basis, src: "xbrl" }]);
    }
  }
  const annual = new Map<string, Ann[]>();
  for (const code of codes) {
    const byFy = new Map<number, Ann>();
    for (const a of xbrlAnn.get(code) ?? []) byFy.set(a.fy, a);
    for (const a of stockRows.get(code) ?? []) byFy.set(a.fy, a); // stock_annual_fundamentals 우선
    annual.set(code, [...byFy.values()].sort((x, y) => (x.rcept === y.rcept ? x.fy - y.fy : x.rcept < y.rcept ? -1 : 1)));
  }
  const groupOf = (code: string): string => { const c = corpMap.get(code); return !c ? "이름 불명(corp_code 없음)" : FIN_NAME_RE.test(c.name) ? "금융(이름 기준)" : "비금융"; };
  const expectedFy = (d: string): number => (Number(d.slice(5, 7)) >= 4 ? Number(d.slice(0, 4)) - 1 : Number(d.slice(0, 4)) - 2);
  const stockMinFy = (code: string): number => Math.min(...(stockRows.get(code) ?? []).map((a) => a.fy), 9999);

  // ---- 구성원-월 판정 ----
  const mms: MM[] = [];
  for (const d of [...monthEnds].sort()) {
    if (d < SEG_FROM) continue;
    for (const code of members.get(d) ?? []) {
      const rows = series.get(code)!;
      const vis = (annual.get(code) ?? []).filter((a) => a.rcept <= d);
      let reason: Reason | null = null, missFy: number | null = null;
      const end = vis[vis.length - 1];
      if (!end) { reason = 1; missFy = expectedFy(d); }
      else {
        const start = vis.find((a) => a.fy === end.fy - PEG_GROWTH_LOOKBACK_YEARS);
        if (!start) { reason = 2; missFy = end.fy - PEG_GROWTH_LOOKBACK_YEARS; }
        else if (start.ni === null || end.ni === null) reason = 3;
        else {
          const sS = pickListedSharesOnOrBefore(rows, start.rcept, DEFAULT_ON_OR_BEFORE_LOOKBACK_DAYS), eS = pickListedSharesOnOrBefore(rows, end.rcept, DEFAULT_ON_OR_BEFORE_LOOKBACK_DAYS);
          if (sS === null || sS <= 0 || eS === null || eS <= 0) reason = 4;
          else if (start.fsDiv !== end.fsDiv) reason = 5;
          else {
            const e0 = start.ni / sS, e1 = end.ni / eS;
            if (e0 <= 0 || e1 <= 0) reason = 6;
            else if (Math.pow(e1 / e0, 1 / PEG_GROWTH_LOOKBACK_YEARS) - 1 <= 0) reason = 7;
          }
        }
      }
      mms.push({ code, date: d, seg: d >= BASE_FROM ? "base" : "ext", year: Number(d.slice(0, 4)), group: groupOf(code), reason, missFy });
    }
  }

  // ---- 보고 1 ----
  console.log("\n=== 1. 연도별 커버리지 (구성원-월, CAGR 계산 가능 비율, 첫 탈락 사유별 건수) ===");
  const groups = ["비금융", "금융(이름 기준)", "이름 불명(corp_code 없음)"];
  const R = [1, 2, 3, 4, 5, 6, 7] as Reason[];
  console.log(`| 구간 | 연도 | 구분 | 월 수 | 구성원-월 | 월평균 구성원 | 계산 가능 | 비율 | ${R.map((r) => `${r} ${REASON_NAME[r]}`).join(" | ")} |`);
  console.log(`|---|---|---|---|---|---|---|---|${R.map(() => "---").join("|")}|`);
  const printRow = (lab: string, yr: string, g: string, rs: MM[], months: number): void => {
    const ok = rs.filter((m) => m.reason === null).length;
    console.log(`| ${lab} | ${yr} | ${g} | ${months} | ${rs.length} | ${months ? (rs.length / months).toFixed(1) : "-"} | ${ok} | ${pc(ok, rs.length)} | ${R.map((r) => rs.filter((m) => m.reason === r).length).join(" | ")} |`);
  };
  for (const seg of ["ext", "base"] as const) {
    const lab = seg === "ext" ? "2016-03~2021-02(확장)" : "2021-03 이후(기존 검증)";
    const years = [...new Set(mms.filter((m) => m.seg === seg).map((m) => m.year))].sort();
    for (const y of [...years, 0]) {
      const ym = mms.filter((m) => m.seg === seg && (y === 0 || m.year === y));
      const months = new Set(ym.map((m) => m.date)).size;
      for (const g of [...groups, "전체"]) {
        const rs = ym.filter((m) => g === "전체" || m.group === g);
        if (g !== "전체" && rs.length === 0) continue;
        printRow(lab, y === 0 ? "합계" : String(y), g, rs, months);
      }
    }
  }

  // ---- 보고 2 ----
  console.log("\n=== 2. 누락 종목 분류 (end/start 행 없음으로 탈락한 구성원-월) ===");
  const drop = mms.filter((m) => m.reason === 1 || m.reason === 2);
  const isDelisted = (code: string): boolean => lastTrade.get(code)! < dataEnd;
  const bEvidence = (m: MM): boolean => {
    const y = m.missFy!;
    if (y <= 2014) return xbrlNoReport.get(m.code)?.has(y) ?? false;
    return stockRows.has(m.code) && stockMinFy(m.code) > y;
  };
  const cat = (m: MM): "a" | "b" | "c" => (isDelisted(m.code) ? "a" : bEvidence(m) ? "b" : "c");
  const byStock = new Map<string, MM[]>();
  for (const m of drop) byStock.set(m.code, [...(byStock.get(m.code) ?? []), m]);
  const stockCat = new Map<string, "a" | "b" | "c">();
  for (const [code, ms] of byStock) stockCat.set(code, isDelisted(code) ? "a" : ms.every((m) => cat(m) === "b") ? "b" : "c");
  console.log("분류 규칙: (a) Parquet 마지막 거래일 < 데이터 끝. (b) a 아님 + 모든 탈락 월에서 필요한 회계연도가 원래 없음 근거(≤FY2014: dart_xbrl_fundamentals no_report / ≥FY2015: stock_annual_fundamentals 첫 행 연도가 그 연도보다 뒤). (c) 그 외(한 달이라도 근거 없음). 필요한 회계연도 = end 없음: 그 달 기준 보고돼 있어야 할 최신 FY, start 없음: end FY-5.");
  console.log("| 분류 | 종목 수 | 구성원-월(end 행 없음) | 구성원-월(start 행 없음) | 구성원-월 합 |");
  console.log("|---|---|---|---|---|");
  for (const [k, lab] of [["a", "(a) 이후 상장폐지·합병"], ["b", "(b) 보고서가 원래 없음(상장 늦음·이력 짧음)"], ["c", "(c) 그 외 = 기존 표 미적재 후보"]] as const) {
    const cs = [...stockCat.entries()].filter(([, v]) => v === k).map(([c]) => c);
    const ms = drop.filter((m) => stockCat.get(m.code) === k);
    console.log(`| ${lab} | ${cs.length} | ${ms.filter((m) => m.reason === 1).length} | ${ms.filter((m) => m.reason === 2).length} | ${ms.length} |`);
  }
  console.log(`| 합계 | ${stockCat.size} | ${drop.filter((m) => m.reason === 1).length} | ${drop.filter((m) => m.reason === 2).length} | ${drop.length} |`);
  const cStocks = [...stockCat.entries()].filter(([, v]) => v === "c").map(([c]) => c);
  let needAll = 0, needListed = 0;
  for (const c of cStocks) {
    const have = new Set((stockRows.get(c) ?? []).map((a) => a.fy));
    const rows = series.get(c)!;
    for (let fy = FY_FILL_FROM; fy <= FY_FILL_TO; fy++) {
      if (have.has(fy)) continue;
      needAll++;
      if (rows.some((r) => r.tradeDate >= `${fy + 1}-01-01` && r.tradeDate <= `${fy + 1}-12-31`)) needListed++;
    }
  }
  console.log(`(c) 종목 ${cStocks.length}개 (corp_code 없음 ${cStocks.filter((c) => !corpMap.has(c)).length}개, 그중 stock_annual_fundamentals 행이 전혀 없는 종목 ${cStocks.filter((c) => !stockRows.has(c)).length}개)`);
  console.log(`(c) FY${FY_FILL_FROM}~FY${FY_FILL_TO} 중 stock_annual_fundamentals에 행이 없는 (종목×연도) ${needAll}건 → fnlttSinglAcntAll 요청 추정 ${needAll}건(연결 CFS 1회 기준; 별도 OFS 폴백 시 최대 ${needAll * 2}건). 그중 해당 FY 다음 해에 Parquet 거래 행이 있는 (상장 중이던) 건 ${needListed}건`);
  const aStocks = [...stockCat.entries()].filter(([, v]) => v === "a").map(([c]) => c);
  const lastFyExpected = (c: string): number => { const l = lastTrade.get(c)!; return Number(l.slice(5, 7)) >= 4 ? Number(l.slice(0, 4)) - 1 : Number(l.slice(0, 4)) - 2; };
  const aCovered = aStocks.filter((c) => lastFyExpected(c) >= FY_FILL_FROM && Math.max(...(stockRows.get(c) ?? []).map((a) => a.fy), 0) >= lastFyExpected(c));
  const aNot = aStocks.filter((c) => lastFyExpected(c) >= FY_FILL_FROM && !aCovered.includes(c));
  console.log(`(a) ${aStocks.length}개 중 stock_annual_fundamentals에 마지막 상장 연도까지의 행(마지막 거래일 기준 보고돼 있어야 할 최신 FY 이상)이 있는 종목 ${aCovered.length}개 / 없는 종목 ${aNot.length}개 / 해당 FY가 2014 이전이라 해당 없음 ${aStocks.length - aCovered.length - aNot.length}개`);

  // ---- 보고 3 ----
  console.log("\n=== 3. 생존편향 점검 ===");
  for (const seg of ["base", "ext"] as const) {
    const lab = seg === "base" ? "2021-03 이후(기존 검증 구간)" : "2016-03~2021-02(확장 구간)";
    const sm = mms.filter((m) => m.seg === seg);
    const okm = sm.filter((m) => m.reason === null);
    const delOk = okm.filter((m) => isDelisted(m.code));
    console.log(`\n[${lab}] 계산 가능 구성원-월 ${okm.length}개 중 이후 상장폐지·합병 종목 ${delOk.length}개 (${pc(delOk.length, okm.length)}); 전체 구성원-월 ${sm.length}개 중 상장폐지 종목 ${sm.filter((m) => isDelisted(m.code)).length}개 (${pc(sm.filter((m) => isDelisted(m.code)).length, sm.length)})`);
    const stocksIn = [...new Set(sm.map((m) => m.code))];
    const hasRow = (c: string): boolean => (annual.get(c) ?? []).some((a) => a.ni !== null);
    const hasUsableEnd = (c: string): boolean => sm.some((m) => m.code === c && m.reason !== 1);
    console.log("| 구분 | 구성원 종목 수 | 순이익 있는 재무 행 보유 종목 | 보유 비율 | 구성원-월 | 계산 가능 | 계산 가능 비율 | end 행 없음 월 비율 |");
    console.log("|---|---|---|---|---|---|---|---|");
    for (const [labl, f] of [["상장폐지·합병", (c: string) => isDelisted(c)], ["생존", (c: string) => !isDelisted(c)]] as [string, (c: string) => boolean][]) {
      const ss = stocksIn.filter(f), ms = sm.filter((m) => f(m.code));
      console.log(`| ${labl} | ${ss.length} | ${ss.filter(hasRow).length} | ${pc(ss.filter(hasRow).length, ss.length)} | ${ms.length} | ${ms.filter((m) => m.reason === null).length} | ${pc(ms.filter((m) => m.reason === null).length, ms.length)} | ${pc(ms.filter((m) => m.reason === 1).length, ms.length)} |`);
      void hasUsableEnd;
    }
  }

  console.log("\n=== 실행 지표 ===");
  console.log(`Supabase 읽은 행: ${Object.entries(dbRead).map(([k, v]) => `${k} ${v}`).join(" | ")} | 합계 ${Object.values(dbRead).reduce((a, b) => a + b, 0)}`);
  console.log(`Supabase 쓴 행: 0 | 외부 요청(DART/KIS 등): 0 | 소요 ${((Date.now() - T0) / 1000).toFixed(0)}초`);
}
main().catch((e) => { console.error(e); process.exit(1); });
