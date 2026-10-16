/**
 * [임시 연구 — 병합 금지, 읽기 전용, 외부 요청 0건] peg_lynch 확장 구간 확정 검증(T69) + B2 재계산(T70).
 * 사전 등록: research/peg-extended-prereg.md (커밋 359da54). 규칙·기준은 그 문서가 고정한다. 숫자와 표, O/X만 출력한다.
 * peg 규칙은 scripts/research-audit-peg.ts와 동일(runBacktest, 조정 적용 로드, entryAllowed, 비용). 재무 로더만 3표 합집합.
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
import { computeIndexDailyReturnsPct, simulateUniverseMonthlyRebalance, computeMonthlyRebalanceDates } from "@/lib/benchmarkSummary";
import { computeEffectiveBuyPrice, computeEffectiveSellPrice } from "@/lib/transactionCost";
import { buildCtx, PERIOD_START, TODAY, CAP_EOK } from "./research-ma-lab";
import { simulateD4, delayedTrade, type Sk, type TR, type Cat } from "./research-audit-peg";

const T0 = Date.now();
const PEG_RULE: StrategyRule = { rule_type: "peg_lynch", rule_params: {} };
const W = { W1: { start: "2016-03-01", end: "2021-02-28" }, W2: { start: "2021-03-01", end: "9999-12-31" }, W3: { start: "2016-03-01", end: "9999-12-31" } } as const;
type WK = keyof typeof W;
const WKS: WK[] = ["W1", "W2", "W3"];
const H3_MIN_HOLD = 10, H3_MAX_CASH_RATIO = 0.2, H4_MAX_DROP = 2.0, TOP_K = 10;
const B2_PEG_W = 0.5, B2_C1_MARGIN = 1.5, B2_C2_MAX_MDD = 35;
const PRIOR = { cagr: 18.72, mdd: 29.26, trades: 707 };
const DB_CHUNK = 100;
const f2 = (x: number): string => (Number.isFinite(x) ? x.toFixed(2) : "-");
const ox = (b: boolean): string => (b ? "O" : "X");
const mean = (v: number[]): number => (v.length ? v.reduce((a, x) => a + x, 0) / v.length : NaN);
const pct = (a: number, b: number): string => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");
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

// ---- 재무 로더(3표 합집합 / stock만) ----
interface FRow { fy: number; rceptNo: string; rcept: string; ni: number | null; eq: number | null; fsDiv: "CFS" | "OFS"; src: "stock" | "fill" | "xbrl" }
function toSeries(rows: FRow[]): FundamentalsSeries {
  const sorted = [...rows].sort((a, b) => (a.rcept === b.rcept ? a.fy - b.fy : a.rcept < b.rcept ? -1 : 1));
  const annual: StockFundamentalsAsOf[] = sorted.map((r) => ({ fiscalYear: r.fy, rceptNo: r.rceptNo, rceptDate: r.rcept, netIncomeParent: r.ni, equityParent: r.eq, fsDiv: r.fsDiv }));
  return { annual, dividends: [] };
}
function listedShares(series: FundamentalsSeries, lsFn: (d: string) => number | null): ListedSharesByFiscalYear {
  return new Map(series.annual.map((a) => [a.fiscalYear, lsFn(a.rceptDate)] as const));
}
function pegStates(prices: DailyPrice[], f: FundamentalsSeries, ls: ListedSharesByFiscalYear): (boolean | undefined)[] {
  return prices.map((p) => {
    if (p.listedShares === undefined) return undefined;
    const fund = pickFundamentalsAsOf(f, p.date);
    if (!fund) return undefined;
    if (fund.netIncomeParent === null) return undefined;
    if (fund.netIncomeParent <= 0) return false;
    const { per } = computeValuationFromSeries(p.close, p.listedShares, fund);
    const pair = selectEpsCagrFiscalYears(f, p.date);
    if (!pair) return undefined;
    const peg = computePeg(per, computeEpsCagrFromResolvedShares(pair, ls));
    if (peg === null) return false;
    return peg <= PEG_MAX_RATIO;
  });
}

// ---- 장부 ----
interface Book { sum: Map<string, number>; cnt: Map<string, number>; trades: TR[] }
const newBook = (): Book => ({ sum: new Map(), cnt: new Map(), trades: [] });
function addTrade(b: Book, t: TR): void {
  b.trades.push(t);
  for (const { d, r } of t.days) { b.sum.set(d, (b.sum.get(d) ?? 0) + r); b.cnt.set(d, (b.cnt.get(d) ?? 0) + 1); }
}
function withoutTrades(b: Book, pred: (t: TR) => boolean): Book {
  const o: Book = { sum: new Map(b.sum), cnt: new Map(b.cnt), trades: [] };
  for (const t of b.trades) {
    if (!pred(t)) { o.trades.push(t); continue; }
    for (const { d, r } of t.days) { o.sum.set(d, (o.sum.get(d) ?? 0) - r); o.cnt.set(d, (o.cnt.get(d) ?? 0) - 1); }
  }
  return o;
}
let CAL: string[] = [];
const bookDaily = (b: Book): number[] => CAL.map((d) => { const c = b.cnt.get(d) ?? 0; return c === 0 ? 0 : ((b.sum.get(d) ?? 0) / c) * 100; });
const endOf = (w: WK): string => (W[w].end > TODAY ? TODAY : W[w].end);
/** 일별 수익률(%) 시계열의 [S, end] 구간 CAGR/MDD/변동성/샤프. */
function metrics(dates: string[], rets: number[], S: string, end: string) {
  const idx: number[] = [];
  for (let i = 0; i < dates.length; i++) if (dates[i] >= S && dates[i] <= end) idx.push(i);
  const r = idx.map((i) => rets[i]);
  const { totalReturnPct, mddPct } = computeCumulativeAndMdd(r);
  const cagr = computeCagrPct(totalReturnPct, S, end);
  const m = mean(r);
  const sd = Math.sqrt(r.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(r.length - 1, 1));
  return { cagr, mdd: mddPct, total: totalReturnPct, vol: sd * Math.sqrt(252), sharpe: sd > 0 ? (m * 252) / (sd * Math.sqrt(252)) : NaN, calmar: mddPct > 0 ? cagr / mddPct : NaN, n: r.length };
}
const yearRet = (dates: string[], rets: number[], y: number, S: string, end: string): number =>
  computeCumulativeAndMdd(rets.filter((_, i) => dates[i].startsWith(`${y}-`) && dates[i] >= S && dates[i] <= end)).totalReturnPct;

async function main(): Promise<void> {
  console.log(`peg 확장 구간 확정 검증 + B2 시작(읽기 전용): ${new Date().toISOString()}`);
  console.log("사전 등록: research/peg-extended-prereg.md, 커밋 359da54(2026-10-16T05:03:48Z) — 이 로그의 시작 시각이 그 이후");
  const adjustments = await loadAppliedAdjustments();
  dbRead["stock_price_adjustment_events(applied)"] = [...adjustments.values()].reduce((a, l) => a + l.length, 0);
  const series = await loadAllStockSeriesFromParquet(2010, new Date().getUTCFullYear(), adjustments);
  console.log(`조정계수 적용 대상 ${adjustments.size}종목, 종목 ${series.size}개 로드`);
  const kospiRaw = await getIndexPriceSeries("KOSPI", PERIOD_START, TODAY);
  dbRead["beta_price_history(KOSPI)"] = kospiRaw.length;

  const calSet = new Set<string>();
  let globalLast = "";
  for (const rows of series.values()) {
    for (const r of rows) if (r.tradeDate >= PERIOD_START) calSet.add(r.tradeDate);
    if (rows.length && rows[rows.length - 1].tradeDate > globalLast) globalLast = rows[rows.length - 1].tradeDate;
  }
  CAL = [...calSet].sort();
  const rebalanceDates = computeMonthlyRebalanceDates(CAL);
  const monthEndSet = new Set<string>();
  for (let k = 0; k + 1 < CAL.length; k++) if (CAL[k].slice(0, 7) !== CAL[k + 1].slice(0, 7)) monthEndSet.add(CAL[k]);
  const monthEnds = [...monthEndSet].sort();
  console.log(`거래일 ${CAL.length}일 ${CAL[0]}~${CAL[CAL.length - 1]}, 데이터 끝 ${globalLast}`);

  // ---- 대상 종목(2016-03 이후 한 번이라도 진입 허용) 선별 후 재무 일괄 로드 ----
  const codes = [...series.keys()];
  const candidate: string[] = [];
  {
    for (const code of codes) {
      const rows = series.get(code)!;
      const tv = computeTrailingAvgTradingValue(rows, PIT_LIQUIDITY_LOOKBACK_DAYS);
      for (let i = 0; i < rows.length; i++) if (rows[i].tradeDate >= W.W1.start && tv[i] >= PIT_MIN_AVG_TRADING_VALUE_WON && rows[i].marketCapEok >= CAP_EOK) { candidate.push(code); break; }
    }
  }
  console.log(`재무 로드 대상(2016-03 이후 진입 허용 이력) ${candidate.length}종목`);
  const rowsBy = { stock: new Map<string, FRow[]>(), fill: new Map<string, FRow[]>(), xbrl: new Map<string, FRow[]>() };
  const monthStock: number[] = new Array(13).fill(0), monthFill: number[] = new Array(13).fill(0);
  for (let i = 0; i < candidate.length; i += DB_CHUNK) {
    const chunk = candidate.slice(i, i + DB_CHUNK);
    const a = await selectAll<{ stock_code: string; fiscal_year: number; rcept_no: string; rcept_date: string; net_income_parent: number | null; equity_parent: number | null; fs_div: string }>("stock_annual_fundamentals", (f, t) => supabaseAdmin.from("stock_annual_fundamentals").select("stock_code, fiscal_year, rcept_no, rcept_date, net_income_parent, equity_parent, fs_div").in("stock_code", chunk).range(f, t));
    for (const r of a) { rowsBy.stock.set(r.stock_code, [...(rowsBy.stock.get(r.stock_code) ?? []), { fy: r.fiscal_year, rceptNo: r.rcept_no, rcept: r.rcept_date, ni: r.net_income_parent === null ? null : Number(r.net_income_parent), eq: r.equity_parent === null ? null : Number(r.equity_parent), fsDiv: r.fs_div as "CFS" | "OFS", src: "stock" }]); monthStock[Number(r.rcept_date.slice(5, 7))]++; }
    const b = await selectAll<{ stock_code: string; fiscal_year: number; rcept_no: string | null; rcept_date: string | null; net_income_parent: number | null; equity_parent: number | null; fs_div: string | null }>("stock_annual_fundamentals_fill(ok)", (f, t) => supabaseAdmin.from("stock_annual_fundamentals_fill").select("stock_code, fiscal_year, rcept_no, rcept_date, net_income_parent, equity_parent, fs_div").eq("status", "ok").in("stock_code", chunk).range(f, t));
    for (const r of b) { if (!r.rcept_date || !r.rcept_no) continue; rowsBy.fill.set(r.stock_code, [...(rowsBy.fill.get(r.stock_code) ?? []), { fy: r.fiscal_year, rceptNo: r.rcept_no, rcept: r.rcept_date, ni: r.net_income_parent === null ? null : Number(r.net_income_parent), eq: r.equity_parent === null ? null : Number(r.equity_parent), fsDiv: (r.fs_div ?? "CFS") as "CFS" | "OFS", src: "fill" }]); monthFill[Number(r.rcept_date.slice(5, 7))]++; }
    const c = await selectAll<{ stock_code: string; fiscal_year: number; rcept_no: string | null; rcept_dt: string | null; ni_parent: number | null; equity_parent: number | null; ni_basis: string | null }>("dart_xbrl_fundamentals", (f, t) => supabaseAdmin.from("dart_xbrl_fundamentals").select("stock_code, fiscal_year, rcept_no, rcept_dt, ni_parent, equity_parent, ni_basis").in("stock_code", chunk).range(f, t));
    for (const r of c) { if (!r.rcept_dt || !r.rcept_no) continue; rowsBy.xbrl.set(r.stock_code, [...(rowsBy.xbrl.get(r.stock_code) ?? []), { fy: r.fiscal_year, rceptNo: r.rcept_no, rcept: r.rcept_dt, ni: r.ni_parent === null ? null : Number(r.ni_parent), eq: r.equity_parent === null ? null : Number(r.equity_parent), fsDiv: r.ni_basis === "sep" ? "OFS" : "CFS", src: "xbrl" }]); }
  }
  const merged = (code: string): FRow[] => {
    const by = new Map<number, FRow>();
    for (const r of rowsBy.xbrl.get(code) ?? []) by.set(r.fy, r);
    for (const r of rowsBy.fill.get(code) ?? []) by.set(r.fy, r);
    for (const r of rowsBy.stock.get(code) ?? []) by.set(r.fy, r);
    return [...by.values()];
  };

  // ---- 종목별 처리 ----
  interface Variant { books: Record<WK, Book>; delayed: Record<WK, Book> }
  const mk = (): Variant => ({ books: { W1: newBook(), W2: newBook(), W3: newBook() }, delayed: { W1: newBook(), W2: newBook(), W3: newBook() } });
  const newV = mk();
  const oldW2 = newBook();
  const stocks: Sk[] = [];
  const pricesByStock = new Map<string, { date: string; close: number }[]>();
  const liquidity = new Map<string, Map<string, number>>();
  const sig = new Map<string, { members: number; nw: number; od: number }>();
  const candSet = new Set(candidate);
  let done = 0;
  for (const code of codes) {
    const rows = series.get(code)!;
    series.delete(code);
    const ctx = buildCtx(code, rows);
    const prices = ctx.prices;
    const idx = new Map(prices.map((p, i) => [p.date, i]));
    stocks.push({ code, dates: prices.map((p) => p.date), close: Float64Array.from(ctx.closes), mcap: Float64Array.from(rows.map((r) => r.marketCapEok)), avgTv: ctx.avgTv, idx });
    pricesByStock.set(code, prices.map((p) => ({ date: p.date, close: p.close })));
    const lq = new Map<string, number>();
    for (const d of rebalanceDates) { const i = idx.get(d); if (i !== undefined && Number.isFinite(ctx.avgTv[i]) && rows[i].marketCapEok >= CAP_EOK) lq.set(d, ctx.avgTv[i]); }
    liquidity.set(code, lq);
    if (!candSet.has(code)) continue;
    const entryAllowed = (date: string): boolean => { const i = idx.get(date); return i !== undefined && ctx.avgTv[i] >= PIT_MIN_AVG_TRADING_VALUE_WON && rows[i].marketCapEok >= CAP_EOK; };
    const lsFn = (d: string): number | null => pickListedSharesOnOrBefore(rows, d, DEFAULT_ON_OR_BEFORE_LOOKBACK_DAYS);
    const fNew = toSeries(merged(code)), fOld = toSeries(rowsBy.stock.get(code) ?? []);
    const lsNew = listedShares(fNew, lsFn), lsOld = listedShares(fOld, lsFn);
    // 월별 신호 종목 수(진입 허용 구성원 중 상태 true)
    const stNew = pegStates(prices, fNew, lsNew), stOld = pegStates(prices, fOld, lsOld);
    for (const d of monthEnds) {
      const i = idx.get(d);
      if (i === undefined || d < W.W2.start || !entryAllowed(d)) continue;
      const e = sig.get(d) ?? sig.set(d, { members: 0, nw: 0, od: 0 }).get(d)!;
      e.members++;
      if (stNew[i] === true) e.nw++;
      if (stOld[i] === true) e.od++;
    }
    for (const w of WKS) {
      const wEnd = W[w].end;
      const pw = wEnd >= prices[prices.length - 1].date ? prices : prices.filter((p) => p.date <= wEnd);
      if (pw.length < 2) continue;
      const res = runBacktest(pw, PEG_RULE, W[w].start, fNew, lsNew, { market: "KR", entryAllowed, includeTransactionCosts: true });
      for (const t of res.trades) {
        const e = idx.get(t.buyDate)!, s = idx.get(t.sellDate)!;
        const cat: Cat = "청산";
        const tmp: DailyStockReturns = new Map();
        accumulateStockDailyReturns(tmp, new Map(), code, pw, [t], W[w].start, "KR", true);
        addTrade(newV.books[w], { code, buyDate: t.buyDate, sellDate: t.sellDate, ret: t.returnPct, cat, eIdx: e, sIdx: s, days: [...tmp.entries()].map(([d, es]) => ({ d, r: es[0].returnPct })) });
        const dl = delayedTrade(code, pw, e, s, 1, cat);
        if (dl) addTrade(newV.delayed[w], dl);
      }
      if (w === "W2") {
        const r2 = runBacktest(pw, PEG_RULE, W[w].start, fOld, lsOld, { market: "KR", entryAllowed, includeTransactionCosts: true });
        for (const t of r2.trades) {
          const e = idx.get(t.buyDate)!, s = idx.get(t.sellDate)!;
          const tmp: DailyStockReturns = new Map();
          accumulateStockDailyReturns(tmp, new Map(), code, pw, [t], W[w].start, "KR", true);
          addTrade(oldW2, { code, buyDate: t.buyDate, sellDate: t.sellDate, ret: t.returnPct, cat: "청산", eIdx: e, sIdx: s, days: [...tmp.entries()].map(([d, es]) => ({ d, r: es[0].returnPct })) });
        }
      }
    }
    if (++done % 200 === 0) console.log(`  진행 ${done}/${candidate.length} 종목, 경과 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
  }

  // ---- 벤치마크 ----
  const ew = simulateUniverseMonthlyRebalance(pricesByStock, CAL, PERIOD_START, (code, date) => (liquidity.get(code)?.get(date) ?? NaN) >= PIT_MIN_AVG_TRADING_VALUE_WON, true);
  const kp = kospiRaw.filter((p) => p.tradeDate >= PERIOD_START);
  const kDates = kp.slice(1).map((p) => p.tradeDate);
  const kRets = computeIndexDailyReturnsPct(kp as never);
  const d4 = simulateD4(stocks, CAL);

  // ---- 기간별 계산 ----
  const dailyOf = (b: Book): number[] => bookDaily(b);
  const startOf = (b: Book, w: WK): string | null => { const t = b.trades.filter((x) => x.buyDate >= W[w].start); return t.length ? `${t.reduce((m, x) => (x.buyDate < m ? x.buyDate : m), "9999").slice(0, 7)}-01` : null; };
  const S: Record<WK, string> = { W1: "", W2: "", W3: "" };
  const pegDaily: Record<WK, number[]> = { W1: [], W2: [], W3: [] };
  for (const w of WKS) { S[w] = startOf(newV.books[w], w) ?? W[w].start; pegDaily[w] = dailyOf(newV.books[w]); }
  const holdStats = (b: Book, w: WK) => {
    const ms = monthEnds.filter((d) => d >= S[w] && d <= endOf(w) && d.slice(0, 7) >= S[w].slice(0, 7));
    const cs = ms.map((d) => b.cnt.get(d) ?? 0);
    return { months: ms.length, avg: mean(cs), min: cs.length ? Math.min(...cs) : NaN, cashRatio: cs.length ? cs.filter((c) => c === 0).length / cs.length : NaN };
  };

  console.log("\n=== (b) 기간별 표 (집계 시작 S = 기간 내 첫 매수일이 속한 달의 1일) ===");
  console.log("| 기간 | S | 끝 | 구성 | CAGR % | MDD % | 거래 수 | 승률 | 월말 평균 보유 | 월말 최소 보유 | 현금 월 비율 | 집계 월 수 |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|---|");
  const M: Record<WK, Record<string, ReturnType<typeof metrics>>> = { W1: {}, W2: {}, W3: {} };
  const H: Record<WK, ReturnType<typeof holdStats>> = { W1: holdStats(newV.books.W1, "W1"), W2: holdStats(newV.books.W2, "W2"), W3: holdStats(newV.books.W3, "W3") };
  for (const w of WKS) {
    const end = endOf(w);
    const trades = newV.books[w].trades.filter((t) => t.buyDate >= W[w].start);
    const wins = trades.filter((t) => t.ret > 0).length;
    M[w].peg = metrics(CAL, pegDaily[w], S[w], end);
    M[w].kospi = metrics(kDates, kRets, S[w], end);
    M[w].d4 = metrics(d4.dates, d4.ret, S[w], end);
    M[w].ew = metrics(CAL, ew, S[w], end);
    console.log(`| ${w} | ${S[w]} | ${end} | peg_lynch | ${f2(M[w].peg.cagr)} | ${f2(M[w].peg.mdd)} | ${trades.length} | ${pct(wins, trades.length)} | ${f2(H[w].avg)} | ${H[w].min} | ${(H[w].cashRatio * 100).toFixed(1)}% | ${H[w].months} |`);
    for (const [k, lab] of [["kospi", "KOSPI"], ["d4", "D4(시총가중)"], ["ew", "유니버스 EW"]] as const) console.log(`| ${w} | ${S[w]} | ${end} | ${lab} | ${f2(M[w][k].cagr)} | ${f2(M[w][k].mdd)} | - | - | - | - | - | - |`);
  }

  console.log("\n=== (c) 연도별 수익률 % (W3 경로, S 이전 연도 제외, 첫 해·2026은 부분 연도) ===");
  const ys: number[] = [];
  for (let y = 2016; y <= 2026; y++) if (`${y}-12-31` >= S.W3) ys.push(y);
  console.log("| 구성 | " + ys.join(" | ") + " |");
  console.log("|---|" + ys.map(() => "---").join("|") + "|");
  for (const [lab, d, r] of [["peg_lynch", CAL, pegDaily.W3], ["D4", d4.dates, d4.ret], ["KOSPI", kDates, kRets]] as [string, string[], number[]][]) console.log(`| ${lab} | ${ys.map((y) => f2(yearRet(d, r, y, S.W3, endOf("W3")))).join(" | ")} |`);

  // ---- (d) H1~H5 ----
  const w1 = M.W1;
  const delayed1 = metrics(CAL, dailyOf(newV.delayed.W1), S.W1, endOf("W1"));
  const sorted1 = [...newV.books.W1.trades].sort((a, b) => b.ret - a.ret || a.buyDate.localeCompare(b.buyDate));
  const top1 = new Set(sorted1.slice(0, TOP_K));
  const noTop1 = metrics(CAL, dailyOf(withoutTrades(newV.books.W1, (t) => top1.has(t))), S.W1, endOf("W1"));
  const hv = {
    H1: w1.peg.cagr > w1.d4.cagr, H2: w1.peg.mdd <= w1.d4.mdd,
    H3: H.W1.avg >= H3_MIN_HOLD && H.W1.cashRatio <= H3_MAX_CASH_RATIO,
    H4: w1.peg.cagr - delayed1.cagr <= H4_MAX_DROP, H5: noTop1.cagr > w1.ew.cagr,
  };
  console.log("\n=== (d) W1 사전 판정 기준 (T69) ===");
  console.log("| 항목 | 측정값 | 기준 | 결과 |\n|---|---|---|---|");
  console.log(`| H1 | peg CAGR ${f2(w1.peg.cagr)} vs D4 ${f2(w1.d4.cagr)} | peg > D4 | ${ox(hv.H1)} |`);
  console.log(`| H2 | peg MDD ${f2(w1.peg.mdd)} vs D4 ${f2(w1.d4.mdd)} | peg ≤ D4 | ${ox(hv.H2)} |`);
  console.log(`| H3 | 월말 평균 보유 ${f2(H.W1.avg)}, 현금 월 비율 ${(H.W1.cashRatio * 100).toFixed(1)}% | 평균 ≥ ${H3_MIN_HOLD} 그리고 현금 월 ≤ ${H3_MAX_CASH_RATIO * 100}% | ${ox(hv.H3)} |`);
  console.log(`| H4 | 지연 없음 ${f2(w1.peg.cagr)} − 지연 ${f2(delayed1.cagr)} = ${f2(w1.peg.cagr - delayed1.cagr)}%p | ≤ ${H4_MAX_DROP}%p | ${ox(hv.H4)} |`);
  console.log(`| H5 | 상위 ${TOP_K}개 제거 CAGR ${f2(noTop1.cagr)} vs EW ${f2(w1.ew.cagr)} | 제거 후 > EW | ${ox(hv.H5)} |`);

  // ---- (e) ----
  console.log("\n=== (e) 지연 +1거래일 / 상위 10개 거래 제거 ===");
  console.log("| 기간 | 구성 | CAGR % | MDD % | 거래 수 |\n|---|---|---|---|---|");
  for (const w of ["W1", "W3"] as WK[]) {
    const end = endOf(w);
    const base = M[w].peg;
    const dl = metrics(CAL, dailyOf(newV.delayed[w]), S[w], end);
    const srt = [...newV.books[w].trades].sort((a, b) => b.ret - a.ret || a.buyDate.localeCompare(b.buyDate));
    const tp = new Set(srt.slice(0, TOP_K));
    const nb = withoutTrades(newV.books[w], (t) => tp.has(t));
    const nt = metrics(CAL, dailyOf(nb), S[w], end);
    console.log(`| ${w} | 기준(신호일 종가) | ${f2(base.cagr)} | ${f2(base.mdd)} | ${newV.books[w].trades.length} |`);
    console.log(`| ${w} | 지연 +1거래일 | ${f2(dl.cagr)} | ${f2(dl.mdd)} | ${newV.delayed[w].trades.length} |`);
    console.log(`| ${w} | 상위 ${TOP_K}개 제거 | ${f2(nt.cagr)} | ${f2(nt.mdd)} | ${nb.trades.length} |`);
  }

  // ---- (f) ----
  console.log("\n=== (f) W2: 이전 검증 수치 vs 이번 값 ===");
  const oldM = metrics(CAL, dailyOf(oldW2), S.W2, endOf("W2"));
  const oldS = startOf(oldW2, "W2");
  const oldM2 = oldS ? metrics(CAL, dailyOf(oldW2), oldS, endOf("W2")) : oldM;
  console.log("| 구성 | S | CAGR % | MDD % | 거래 수 |\n|---|---|---|---|---|");
  console.log(`| 이전 검증 수치(사용자 제시; 거래 707은 2010 시작 기준 수치라 정의가 다름) | - | ${PRIOR.cagr} | ${PRIOR.mdd} | ${PRIOR.trades} |`);
  console.log(`| 이번 실행, stock_annual_fundamentals만 (이전 재무 정의 재계산) | ${oldS ?? S.W2} | ${f2(oldM2.cagr)} | ${f2(oldM2.mdd)} | ${oldW2.trades.length} |`);
  console.log(`| 이번 실행, 3표 합집합 | ${S.W2} | ${f2(M.W2.peg.cagr)} | ${f2(M.W2.peg.mdd)} | ${newV.books.W2.trades.length} |`);
  console.log("\n월별 신호 종목 수 (월말 진입 허용 구성원 중 peg 상태 true, W2 완결 달)");
  console.log("| 연도 | 월 수 | 구성원 평균 | 합집합 평균 | stock만 평균 | 차이(합집합−stock만) 평균 | 합집합>stock만인 달 | 같은 달 | 합집합<stock만인 달 |\n|---|---|---|---|---|---|---|---|---|");
  const sigKeys = [...sig.keys()].sort();
  for (const y of [...new Set(sigKeys.map((d) => d.slice(0, 4)))]) {
    const ds = sigKeys.filter((d) => d.startsWith(y));
    const a = ds.map((d) => sig.get(d)!);
    console.log(`| ${y} | ${ds.length} | ${mean(a.map((x) => x.members)).toFixed(1)} | ${mean(a.map((x) => x.nw)).toFixed(1)} | ${mean(a.map((x) => x.od)).toFixed(1)} | ${mean(a.map((x) => x.nw - x.od)).toFixed(1)} | ${a.filter((x) => x.nw > x.od).length} | ${a.filter((x) => x.nw === x.od).length} | ${a.filter((x) => x.nw < x.od).length} |`);
  }
  { const a = sigKeys.map((d) => sig.get(d)!); console.log(`| 전체 | ${sigKeys.length} | ${mean(a.map((x) => x.members)).toFixed(1)} | ${mean(a.map((x) => x.nw)).toFixed(1)} | ${mean(a.map((x) => x.od)).toFixed(1)} | ${mean(a.map((x) => x.nw - x.od)).toFixed(1)} | ${a.filter((x) => x.nw > x.od).length} | ${a.filter((x) => x.nw === x.od).length} | ${a.filter((x) => x.nw < x.od).length} |`); }

  // ---- (g) B2 ----
  console.log("\n=== (g) B2 블렌드 (D4 50 + peg_lynch 50, 매월 말 재배분) ===");
  const buyRate = computeEffectiveBuyPrice(1) - 1;
  function blend(w: WK, withCost: boolean): { dates: string[]; ret: number[]; totalCost: number } {
    const end = endOf(w);
    const d4m = new Map(d4.dates.map((d, i) => [d, d4.ret[i]]));
    let vp = B2_PEG_W, vd = 1 - B2_PEG_W;
    let prev = 1, totalCost = 0;
    const out = { dates: [] as string[], ret: [] as number[], totalCost: 0 };
    for (let i = 0; i < CAL.length; i++) {
      const d = CAL[i];
      if (d < S[w] || d > end) continue;
      vp *= 1 + pegDaily[w][i] / 100;
      vd *= 1 + (d4m.get(d) ?? 0) / 100;
      if (monthEndSet.has(d)) {
        const T = vp + vd, move = Math.abs(vp - T * B2_PEG_W);
        const cost = withCost ? move * (buyRate + (1 - computeEffectiveSellPrice(1, d, "KR"))) : 0;
        totalCost += cost;
        const T2 = T - cost;
        vp = T2 * B2_PEG_W; vd = T2 * (1 - B2_PEG_W);
      }
      const V = vp + vd;
      out.dates.push(d); out.ret.push((V / prev - 1) * 100);
      prev = V;
    }
    out.totalCost = totalCost;
    return out;
  }
  console.log("| 기간 | 구성 | CAGR % | MDD % | 연변동성 % | 샤프 | CAGR÷MDD | 누적 리밸런싱 비용(초기 자본 대비 단순합 %) |\n|---|---|---|---|---|---|---|---|");
  for (const w of ["W1", "W3"] as WK[]) {
    const end = endOf(w);
    const b0 = blend(w, false), b1 = blend(w, true);
    const m0 = metrics(b0.dates, b0.ret, S[w], end), m1 = metrics(b1.dates, b1.ret, S[w], end);
    const rows: [string, ReturnType<typeof metrics>, string][] = [
      ["B2 비용 미포함", m0, "0"], ["B2 비용 포함", m1, (b1.totalCost * 100).toFixed(2)],
      ["D4", M[w].d4, "-"], ["KOSPI", M[w].kospi, "-"], ["peg_lynch(슬리브)", M[w].peg, "-"],
    ];
    for (const [lab, m, c] of rows) console.log(`| ${w} | ${lab} | ${f2(m.cagr)} | ${f2(m.mdd)} | ${f2(m.vol)} | ${f2(m.sharpe)} | ${f2(m.calmar)} | ${c} |`);
    // 기준
    const c1 = m1.cagr >= M[w].d4.cagr - B2_C1_MARGIN, c2 = m1.mdd <= B2_C2_MAX_MDD;
    let c3: boolean, c3txt: string;
    if (w === "W1") { c3 = m1.calmar >= M[w].kospi.calmar; c3txt = `B2 ${f2(m1.calmar)} vs KOSPI ${f2(M[w].kospi.calmar)}`; }
    else {
      const sp = "2021-03-01";
      const pa = [S.W3, "2021-02-28"] as const, pb = [sp, end] as const;
      const bA = metrics(b1.dates, b1.ret, pa[0], pa[1]), kA = metrics(kDates, kRets, pa[0], pa[1]);
      const bB = metrics(b1.dates, b1.ret, pb[0], pb[1]), kB = metrics(kDates, kRets, pb[0], pb[1]);
      c3 = bA.calmar >= kA.calmar && bB.calmar >= kB.calmar;
      c3txt = `앞 구간 B2 ${f2(bA.calmar)} vs KOSPI ${f2(kA.calmar)}; 뒤 구간 B2 ${f2(bB.calmar)} vs KOSPI ${f2(kB.calmar)}`;
    }
    console.log(`  [${w} 기준, 비용 포함 값] C1 ${ox(c1)} (B2 CAGR ${f2(m1.cagr)} ≥ D4 ${f2(M[w].d4.cagr)} − ${B2_C1_MARGIN}) | C2 ${ox(c2)} (MDD ${f2(m1.mdd)} ≤ ${B2_C2_MAX_MDD}) | C3 ${ox(c3)} (${c3txt}) | 세 개 모두 O: ${ox(c1 && c2 && c3)}`);
    const w0c1 = m0.cagr >= M[w].d4.cagr - B2_C1_MARGIN, w0c2 = m0.mdd <= B2_C2_MAX_MDD;
    console.log(`  [${w} 참고, 비용 미포함 값] C1 ${ox(w0c1)} | C2 ${ox(w0c2)} (C3는 비용 포함 기준만 표기)`);
  }

  // ---- (h) 12월 결산 점검 ----
  console.log("\n=== (h) 12월 결산 점검: rcept_date 월 분포 ===");
  const tf = monthFill.reduce((a, x) => a + x, 0), ts = monthStock.reduce((a, x) => a + x, 0);
  console.log("| 월 | fill ok 행 | 비율 | stock_annual_fundamentals 행 | 비율 |\n|---|---|---|---|---|");
  for (let m = 1; m <= 12; m++) console.log(`| ${m} | ${monthFill[m]} | ${pct(monthFill[m], tf)} | ${monthStock[m]} | ${pct(monthStock[m], ts)} |`);
  const lateF = monthFill.slice(5).reduce((a, x) => a + x, 0), lateS = monthStock.slice(5).reduce((a, x) => a + x, 0);
  console.log(`| 합계 | ${tf} | | ${ts} | |\n5월 이후 접수 비율: fill ok ${lateF}/${tf} (${pct(lateF, tf)}) | stock_annual_fundamentals ${lateS}/${ts} (${pct(lateS, ts)}) (대상: 재무 로드 ${candidate.length}종목의 행)`);

  console.log("\n=== (i) 실행 지표 ===");
  console.log(`Supabase 읽은 행: ${Object.entries(dbRead).map(([k, v]) => `${k} ${v}`).join(" | ")} | 합계 ${Object.values(dbRead).reduce((a, b) => a + b, 0)}`);
  console.log(`Supabase 쓴 행: 0 | 외부 요청(DART/KIS 등): 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
}
main().catch((e) => { console.error(e); process.exit(1); });
