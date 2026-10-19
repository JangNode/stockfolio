/**
 * [임시 확인 — 병합 금지, 읽기 전용, 외부 요청 0건, DB 쓰기 0] 주간 배치(2026-10-19 05:00 KST 예약) 후 화면 수치 확인.
 * (2) strategy_backtest_summary / benchmark_summary 이전 값·새 값 조회, (4) 다른 전략 저장값 변동 조회,
 * (3) 연구 스크립트(scripts/research-peg-extended.ts의 3표 합집합 재무 로더·엔진)로 peg_lynch를 시작 2010-01-01로 1회 재계산해 화면 저장값과 비교.
 */
import { getIndexPriceSeries } from "@/lib/betaPriceHistoryStorage";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { DEFAULT_ON_OR_BEFORE_LOOKBACK_DAYS, loadAllStockSeriesFromParquet } from "@/lib/stockDailyPricesStorage";
import { loadAppliedAdjustments } from "@/lib/stockPriceAdjustmentsStorage";
import { pickFundamentalsAsOf, computeValuationFromSeries, type FundamentalsSeries, type StockFundamentalsAsOf } from "@/lib/pointInTimeFundamentals";
import { selectEpsCagrFiscalYears, computeEpsCagrFromResolvedShares, computePeg, type ListedSharesByFiscalYear } from "@/lib/pegRatio";
import { PEG_MAX_RATIO } from "@/lib/pegConfig";
import { runBacktest, type DailyPrice, type StrategyRule } from "@/lib/backtest";
import { pickListedSharesOnOrBefore, computeTrailingAvgTradingValue } from "@/lib/pitUniverse";
import { PIT_MIN_AVG_TRADING_VALUE_WON, PIT_LIQUIDITY_LOOKBACK_DAYS } from "@/lib/strategyBacktestSummaryConfig";
import { accumulateStockDailyReturns, computeCumulativeAndMdd, computeCagrPct, type DailyStockReturns } from "@/lib/strategyBacktestSummary";
import { computeEffectiveBuyPrice } from "@/lib/transactionCost";
import { buildCtx, PERIOD_START, CAP_EOK } from "./research-ma-lab";
import {
  SCREEN_CHECK_NEW_FROM, SCREEN_CHECK_PREV_BEFORE, SCREEN_CHECK_PEG_STAGES, SCREEN_CHECK_ALL_STAGES, SCREEN_CHECK_RECALC_START, SCREEN_CHECK_REF_STARTS,
  SCREEN_CHECK_DB_CHUNK, SCREEN_CHECK_TOLERANCE_PP,
} from "@/lib/pegScreenCheckConfig";

void computeEffectiveBuyPrice;
const T0 = Date.now();
const PEG_RULE: StrategyRule = { rule_type: "peg_lynch", rule_params: {} };
const f2 = (x: number | null | undefined): string => (x === null || x === undefined || !Number.isFinite(Number(x)) ? "-" : Number(x).toFixed(2));
const dbRead: Record<string, number> = {};

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

// ---- 재무 로더(research-peg-extended.ts와 동일) ----
interface FRow { fy: number; rceptNo: string; rcept: string; ni: number | null; eq: number | null; fsDiv: "CFS" | "OFS" }
function toSeries(rows: FRow[]): FundamentalsSeries {
  const sorted = [...rows].sort((a, b) => (a.rcept === b.rcept ? a.fy - b.fy : a.rcept < b.rcept ? -1 : 1));
  const annual: StockFundamentalsAsOf[] = sorted.map((r) => ({ fiscalYear: r.fy, rceptNo: r.rceptNo, rceptDate: r.rcept, netIncomeParent: r.ni, equityParent: r.eq, fsDiv: r.fsDiv }));
  return { annual, dividends: [] };
}
function listedShares(series: FundamentalsSeries, lsFn: (d: string) => number | null): ListedSharesByFiscalYear {
  return new Map(series.annual.map((a) => [a.fiscalYear, lsFn(a.rceptDate)] as const));
}

interface SumRow { rule_type: string; data_widen_stage: string | null; computed_at: string; period_start_date: string; period_end_date: string; cagr_pct: number | null; mdd_pct: number | null; total_trades: number; win_rate: number | null; avg_return_pct: number | null }
interface BenchRow { benchmark_type: string; data_widen_stage: string | null; computed_at: string; period_start_date: string; period_end_date: string; cagr_pct: number; mdd_pct: number; calmar_ratio: number }

async function main(): Promise<void> {
  console.log(`주간 배치 후 화면 수치 확인 시작(읽기 전용): ${new Date().toISOString()}`);

  // ================= (2)(4) 저장값 조회 =================
  const sums = await selectAll<SumRow>("strategy_backtest_summary", (f, t) => supabaseAdmin.from("strategy_backtest_summary").select("rule_type, data_widen_stage, computed_at, period_start_date, period_end_date, cagr_pct, mdd_pct, total_trades, win_rate, avg_return_pct").eq("market", "KR").order("computed_at", { ascending: false }).range(f, t));
  const benches = await selectAll<BenchRow>("benchmark_summary", (f, t) => supabaseAdmin.from("benchmark_summary").select("benchmark_type, data_widen_stage, computed_at, period_start_date, period_end_date, cagr_pct, mdd_pct, calmar_ratio").order("computed_at", { ascending: false }).range(f, t));
  const stageOf = (s: string | null): string => s ?? "(null)";
  const isNew = (c: string): boolean => c >= SCREEN_CHECK_NEW_FROM;
  const isPrev = (c: string): boolean => c < SCREEN_CHECK_PREV_BEFORE;
  console.log(`\n읽은 요약 행: strategy_backtest_summary(KR) ${sums.length}, benchmark_summary ${benches.length}`);
  console.log(`새 값 판정: computed_at ≥ ${SCREEN_CHECK_NEW_FROM} | 이전 값: computed_at < ${SCREEN_CHECK_PREV_BEFORE} 중 가장 최근 행`);

  const pick = <T extends { computed_at: string }>(rows: T[], pred: (r: T) => boolean, which: "new" | "prev"): T | undefined =>
    rows.filter((r) => (which === "new" ? isNew(r.computed_at) : isPrev(r.computed_at)) && pred(r)).sort((a, b) => (a.computed_at < b.computed_at ? 1 : -1))[0];

  console.log("\n=== 2. peg_lynch 이전 값 vs 새 값 (strategy_backtest_summary) ===");
  console.log("| stage | 구분 | computed_at(UTC) | 기간 | CAGR % | MDD % | 거래 수 | 승률 % | 평균수익 % |\n|---|---|---|---|---|---|---|---|---|");
  const screenPeg = new Map<string, SumRow | undefined>();
  for (const st of SCREEN_CHECK_PEG_STAGES) {
    for (const which of ["prev", "new"] as const) {
      const r = pick(sums, (x) => x.rule_type === "peg_lynch" && stageOf(x.data_widen_stage) === st, which);
      if (which === "new") screenPeg.set(st, r);
      console.log(`| ${st} | ${which === "prev" ? "이전" : "새"} | ${r?.computed_at.slice(0, 19) ?? "-"} | ${r ? `${r.period_start_date}~${r.period_end_date}` : "-"} | ${f2(r?.cagr_pct)} | ${f2(r?.mdd_pct)} | ${r?.total_trades ?? "-"} | ${r?.win_rate === null || r?.win_rate === undefined ? "-" : f2(Number(r.win_rate) * 100)} | ${f2(r?.avg_return_pct)} |`);
    }
  }
  console.log("\npeg_lynch 저장 이력(최근 순, stage별 최대 8행):");
  console.log("| stage | computed_at(UTC) | 기간 | CAGR % | MDD % | 거래 수 |\n|---|---|---|---|---|---|");
  for (const st of SCREEN_CHECK_PEG_STAGES) for (const r of sums.filter((x) => x.rule_type === "peg_lynch" && stageOf(x.data_widen_stage) === st).slice(0, 8)) console.log(`| ${st} | ${r.computed_at.slice(0, 19)} | ${r.period_start_date}~${r.period_end_date} | ${f2(r.cagr_pct)} | ${f2(r.mdd_pct)} | ${r.total_trades} |`);

  console.log("\n같은 stage의 벤치마크 (benchmark_summary) 이전 vs 새");
  console.log("| stage | 벤치마크 | 구분 | computed_at(UTC) | 기간 | CAGR % | MDD % | 칼마 |\n|---|---|---|---|---|---|---|---|");
  const benchTypes = [...new Set(benches.map((b) => b.benchmark_type))].sort();
  for (const st of SCREEN_CHECK_PEG_STAGES) for (const bt of benchTypes) for (const which of ["prev", "new"] as const) {
    const r = pick(benches, (x) => x.benchmark_type === bt && stageOf(x.data_widen_stage) === st, which);
    if (!r && which === "prev") { const any = pick(benches, (x) => x.benchmark_type === bt && stageOf(x.data_widen_stage) === st, "new"); if (!any) continue; }
    console.log(`| ${st} | ${bt} | ${which === "prev" ? "이전" : "새"} | ${r?.computed_at.slice(0, 19) ?? "-"} | ${r ? `${r.period_start_date}~${r.period_end_date}` : "-"} | ${f2(r?.cagr_pct)} | ${f2(r?.mdd_pct)} | ${f2(r?.calmar_ratio)} |`);
  }
  console.log(`저장돼 있는 benchmark_type 전체: ${benchTypes.join(", ")} (D4 포함 여부: ${benchTypes.some((b) => /d4/i.test(b)) ? "포함" : "저장돼 있지 않음"})`);

  console.log("\n=== 4. 다른 전략 저장값 변동 (peg_lynch 제외, stage별 이전 → 새) ===");
  console.log("| stage | rule_type | 이전 computed_at | 새 computed_at | 이전 기간 끝 | 새 기간 끝 | CAGR 이전 | CAGR 새 | MDD 이전 | MDD 새 | 거래 수 이전 | 거래 수 새 |\n|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const st of SCREEN_CHECK_ALL_STAGES) for (const rt of [...new Set(sums.filter((x) => stageOf(x.data_widen_stage) === st && x.rule_type !== "peg_lynch").map((x) => x.rule_type))].sort()) {
    const a = pick(sums, (x) => x.rule_type === rt && stageOf(x.data_widen_stage) === st, "prev"), b = pick(sums, (x) => x.rule_type === rt && stageOf(x.data_widen_stage) === st, "new");
    console.log(`| ${st} | ${rt} | ${a?.computed_at.slice(0, 19) ?? "-"} | ${b?.computed_at.slice(0, 19) ?? "-"} | ${a?.period_end_date ?? "-"} | ${b?.period_end_date ?? "-"} | ${f2(a?.cagr_pct)} | ${f2(b?.cagr_pct)} | ${f2(a?.mdd_pct)} | ${f2(b?.mdd_pct)} | ${a?.total_trades ?? "-"} | ${b?.total_trades ?? "-"} |`);
  }
  console.log("\n벤치마크(코스피·코스닥·유니버스 EW 등) 변동 (이전 → 새):");
  console.log("| stage | 벤치마크 | 이전 기간 끝 | 새 기간 끝 | CAGR 이전 | CAGR 새 | MDD 이전 | MDD 새 |\n|---|---|---|---|---|---|---|---|");
  for (const st of SCREEN_CHECK_ALL_STAGES) for (const bt of benchTypes) {
    const a = pick(benches, (x) => x.benchmark_type === bt && stageOf(x.data_widen_stage) === st, "prev"), b = pick(benches, (x) => x.benchmark_type === bt && stageOf(x.data_widen_stage) === st, "new");
    if (!a && !b) continue;
    console.log(`| ${st} | ${bt} | ${a?.period_end_date ?? "-"} | ${b?.period_end_date ?? "-"} | ${f2(a?.cagr_pct)} | ${f2(b?.cagr_pct)} | ${f2(a?.mdd_pct)} | ${f2(b?.mdd_pct)} |`);
  }

  // ================= (3) 재계산 =================
  const stage2010 = screenPeg.get("pit_adjusted_cap5000_from2010");
  const periodEnd = stage2010?.period_end_date ?? new Date().toISOString().slice(0, 10);
  console.log(`\n=== 3. peg_lynch 재계산 (시작 ${SCREEN_CHECK_RECALC_START}, 화면 저장값 기간 끝 ${periodEnd}) ===`);
  const adjustments = await loadAppliedAdjustments();
  dbRead["stock_price_adjustment_events(applied)"] = [...adjustments.values()].reduce((a, l) => a + l.length, 0);
  const series = await loadAllStockSeriesFromParquet(2010, new Date().getUTCFullYear(), adjustments);
  console.log(`조정계수 적용 대상 ${adjustments.size}종목, 종목 ${series.size}개 로드`);
  const calSet = new Set<string>();
  for (const rows of series.values()) for (const r of rows) if (r.tradeDate >= PERIOD_START) calSet.add(r.tradeDate);
  const CAL = [...calSet].sort();
  const codes = [...series.keys()];
  const candidate: string[] = [];
  for (const code of codes) {
    const rows = series.get(code)!;
    const tv = computeTrailingAvgTradingValue(rows, PIT_LIQUIDITY_LOOKBACK_DAYS);
    for (let i = 0; i < rows.length; i++) if (rows[i].tradeDate >= SCREEN_CHECK_RECALC_START && tv[i] >= PIT_MIN_AVG_TRADING_VALUE_WON && rows[i].marketCapEok >= CAP_EOK) { candidate.push(code); break; }
  }
  console.log(`재무 로드 대상 ${candidate.length}종목 (거래일 ${CAL.length}일 ${CAL[0]}~${CAL[CAL.length - 1]})`);
  const rowsBy = { stock: new Map<string, FRow[]>(), fill: new Map<string, FRow[]>(), xbrl: new Map<string, FRow[]>() };
  const push = (m: Map<string, FRow[]>, code: string, r: FRow): void => { const a = m.get(code); if (a) a.push(r); else m.set(code, [r]); };
  for (let i = 0; i < candidate.length; i += SCREEN_CHECK_DB_CHUNK) {
    const chunk = candidate.slice(i, i + SCREEN_CHECK_DB_CHUNK);
    const a = await selectAll<{ stock_code: string; fiscal_year: number; rcept_no: string; rcept_date: string; net_income_parent: number | null; equity_parent: number | null; fs_div: string }>("stock_annual_fundamentals", (f, t) => supabaseAdmin.from("stock_annual_fundamentals").select("stock_code, fiscal_year, rcept_no, rcept_date, net_income_parent, equity_parent, fs_div").in("stock_code", chunk).range(f, t));
    for (const r of a) push(rowsBy.stock, r.stock_code, { fy: r.fiscal_year, rceptNo: r.rcept_no, rcept: r.rcept_date, ni: r.net_income_parent === null ? null : Number(r.net_income_parent), eq: r.equity_parent === null ? null : Number(r.equity_parent), fsDiv: r.fs_div as "CFS" | "OFS" });
    const b = await selectAll<{ stock_code: string; fiscal_year: number; rcept_no: string | null; rcept_date: string | null; net_income_parent: number | null; equity_parent: number | null; fs_div: string | null }>("stock_annual_fundamentals_fill(ok)", (f, t) => supabaseAdmin.from("stock_annual_fundamentals_fill").select("stock_code, fiscal_year, rcept_no, rcept_date, net_income_parent, equity_parent, fs_div").eq("status", "ok").in("stock_code", chunk).range(f, t));
    for (const r of b) { if (!r.rcept_date || !r.rcept_no) continue; push(rowsBy.fill, r.stock_code, { fy: r.fiscal_year, rceptNo: r.rcept_no, rcept: r.rcept_date, ni: r.net_income_parent === null ? null : Number(r.net_income_parent), eq: r.equity_parent === null ? null : Number(r.equity_parent), fsDiv: (r.fs_div ?? "CFS") as "CFS" | "OFS" }); }
    const c = await selectAll<{ stock_code: string; fiscal_year: number; rcept_no: string | null; rcept_dt: string | null; ni_parent: number | null; equity_parent: number | null; ni_basis: string | null }>("dart_xbrl_fundamentals", (f, t) => supabaseAdmin.from("dart_xbrl_fundamentals").select("stock_code, fiscal_year, rcept_no, rcept_dt, ni_parent, equity_parent, ni_basis").in("stock_code", chunk).range(f, t));
    for (const r of c) { if (!r.rcept_dt || !r.rcept_no) continue; push(rowsBy.xbrl, r.stock_code, { fy: r.fiscal_year, rceptNo: r.rcept_no, rcept: r.rcept_dt, ni: r.ni_parent === null ? null : Number(r.ni_parent), eq: r.equity_parent === null ? null : Number(r.equity_parent), fsDiv: r.ni_basis === "sep" ? "OFS" : "CFS" }); }
  }
  const merged = (code: string): FRow[] => {
    const by = new Map<number, FRow>();
    for (const r of rowsBy.xbrl.get(code) ?? []) by.set(r.fy, r);
    for (const r of rowsBy.fill.get(code) ?? []) by.set(r.fy, r);
    for (const r of rowsBy.stock.get(code) ?? []) by.set(r.fy, r);
    return [...by.values()];
  };

  interface Tr { buyDate: string; ret: number; days: { d: string; r: number }[] }
  const books = { union: [] as Tr[], stockOnly: [] as Tr[] };
  const candSet = new Set(candidate);
  let done = 0;
  for (const code of codes) {
    const rows = series.get(code)!;
    series.delete(code);
    if (!candSet.has(code)) continue;
    const ctx = buildCtx(code, rows);
    const prices = ctx.prices as DailyPrice[];
    const idx = new Map(prices.map((p, i) => [p.date, i]));
    const entryAllowed = (date: string): boolean => { const i = idx.get(date); return i !== undefined && ctx.avgTv[i] >= PIT_MIN_AVG_TRADING_VALUE_WON && rows[i].marketCapEok >= CAP_EOK; };
    const lsFn = (d: string): number | null => pickListedSharesOnOrBefore(rows, d, DEFAULT_ON_OR_BEFORE_LOOKBACK_DAYS);
    for (const [key, fr] of [["union", toSeries(merged(code))], ["stockOnly", toSeries(rowsBy.stock.get(code) ?? [])]] as const) {
      const ls = listedShares(fr, lsFn);
      const res = runBacktest(prices, PEG_RULE, SCREEN_CHECK_RECALC_START, fr, ls, { market: "KR", entryAllowed, includeTransactionCosts: true });
      for (const t of res.trades) {
        const tmp: DailyStockReturns = new Map();
        accumulateStockDailyReturns(tmp, new Map(), code, prices, [t], SCREEN_CHECK_RECALC_START, "KR", true);
        books[key].push({ buyDate: t.buyDate, ret: t.returnPct, days: [...tmp.entries()].map(([d, es]) => ({ d, r: es[0].returnPct })) });
      }
    }
    if (++done % 200 === 0) console.log(`  진행 ${done}/${candidate.length} 종목, 경과 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
  }
  void getIndexPriceSeries;

  const daily = (trades: Tr[]): number[] => {
    const sum = new Map<string, number>(), cnt = new Map<string, number>();
    for (const t of trades) for (const { d, r } of t.days) { sum.set(d, (sum.get(d) ?? 0) + r); cnt.set(d, (cnt.get(d) ?? 0) + 1); }
    return CAL.map((d) => { const c = cnt.get(d) ?? 0; return c === 0 ? 0 : ((sum.get(d) ?? 0) / c) * 100; });
  };
  const metricsFrom = (trades: Tr[], S: string, end: string): { cagr: number; mdd: number } => {
    const r = daily(trades);
    const sel = CAL.map((d, i) => (d >= S && d <= end ? r[i] : null)).filter((x): x is number => x !== null);
    const { totalReturnPct, mddPct } = computeCumulativeAndMdd(sel);
    return { cagr: computeCagrPct(totalReturnPct, S, end), mdd: mddPct };
  };
  const firstBuyMonth = (trades: Tr[]): string => `${trades.reduce((m, x) => (x.buyDate < m ? x.buyDate : m), "9999").slice(0, 7)}-01`;

  const scr = stage2010;
  console.log(`\n화면 저장값 (pit_adjusted_cap5000_from2010, 새 행): CAGR ${f2(scr?.cagr_pct)} / MDD ${f2(scr?.mdd_pct)} / 거래 ${scr?.total_trades ?? "-"} (기간 ${scr?.period_start_date}~${scr?.period_end_date})`);
  console.log("\n| 재무 정의 | 집계 기준 | CAGR % | MDD % | 거래 수 | 화면 저장값과 비교 |\n|---|---|---|---|---|---|");
  for (const [lab, key] of [["3표 합집합", "union"], ["stock_annual_fundamentals만", "stockOnly"]] as const) {
    const trades = books[key];
    const m = metricsFrom(trades, SCREEN_CHECK_RECALC_START, periodEnd);
    const same = scr ? Math.abs(m.cagr - Number(scr.cagr_pct)) <= SCREEN_CHECK_TOLERANCE_PP && Math.abs(m.mdd - Number(scr.mdd_pct)) <= SCREEN_CHECK_TOLERANCE_PP && trades.length === scr.total_trades : false;
    console.log(`| ${lab} | 화면 방식(${SCREEN_CHECK_RECALC_START}~${periodEnd}) | ${f2(m.cagr)} | ${f2(m.mdd)} | ${trades.length} | ${scr ? (same ? "같음" : `다름 (화면 ${f2(scr.cagr_pct)}/${f2(scr.mdd_pct)}/${scr.total_trades})`) : "-"} |`);
    const S = firstBuyMonth(trades);
    const m2 = metricsFrom(trades, S, periodEnd);
    console.log(`| ${lab} | 연구 방식(첫 매수 달 ${S}~${periodEnd}) | ${f2(m2.cagr)} | ${f2(m2.mdd)} | ${trades.length} | - |`);
  }
  console.log(`\n연구 참조 구간 (같은 2010 시작 재계산에서 해당 날짜 이후 매수 거래만, 집계 시작 = 첫 매수 달 1일, 끝 ${periodEnd}) — 참고 연구 수치: 2016-03~ 6.09/49.18/1,131건, 2021-03~ 8.74/30.87/779건`);
  console.log("| 재무 정의 | 구간 | S | CAGR % | MDD % | 거래 수 |\n|---|---|---|---|---|---|");
  for (const [lab, key] of [["3표 합집합", "union"], ["stock_annual_fundamentals만", "stockOnly"]] as const) for (const st of SCREEN_CHECK_REF_STARTS) {
    const sub = books[key].filter((t) => t.buyDate >= st);
    if (!sub.length) { console.log(`| ${lab} | ${st}~ | - | - | - | 0 |`); continue; }
    const S = firstBuyMonth(sub), m = metricsFrom(sub, S, periodEnd);
    console.log(`| ${lab} | ${st}~ | ${S} | ${f2(m.cagr)} | ${f2(m.mdd)} | ${sub.length} |`);
  }
  console.log(`\nSupabase 읽은 행 ${JSON.stringify(dbRead)} 쓴 행 0 | 외부 요청 0 | 소요 ${((Date.now() - T0) / 1000).toFixed(1)}s`);
}

main().catch((e) => { console.error("실패:", e instanceof Error ? e.message : e); process.exit(1); });
