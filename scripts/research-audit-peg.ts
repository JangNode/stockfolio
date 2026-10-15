/**
 * [임시 감사 — 병합 금지, 읽기 전용] peg_lynch 재검증 감사(P1~P6).
 * 사전 등록: research/audit-peg-prereg.md. 규칙 변경 없음(운영 runBacktest 그대로), 판정·추천 없이 숫자와 O/X만 출력한다.
 * DB는 stock_annual_fundamentals / stock_dividend_history / beta_price_history / stock_price_adjustment_events 조회만(쓰기 없음).
 */
import { getIndexPriceSeries } from "@/lib/betaPriceHistoryStorage";
import { DEFAULT_ON_OR_BEFORE_LOOKBACK_DAYS, loadAllStockSeriesFromParquet, type StockDailyPriceRow } from "@/lib/stockDailyPricesStorage";
import { loadAppliedAdjustments } from "@/lib/stockPriceAdjustmentsStorage";
import { loadFundamentalsSeriesWithListedShares } from "@/lib/stockFundamentals";
import { pickFundamentalsAsOf, computeValuationFromSeries, type FundamentalsSeries } from "@/lib/pointInTimeFundamentals";
import { selectEpsCagrFiscalYears, computeEpsCagrFromResolvedShares, computePeg, type ListedSharesByFiscalYear } from "@/lib/pegRatio";
import { PEG_MAX_RATIO } from "@/lib/pegConfig";
import { runBacktest, type DailyPrice, type StrategyRule } from "@/lib/backtest";
import { computeTrailingAvgTradingValue, pickListedSharesOnOrBefore } from "@/lib/pitUniverse";
import { PIT_LIQUIDITY_LOOKBACK_DAYS, PIT_MIN_AVG_TRADING_VALUE_WON } from "@/lib/strategyBacktestSummaryConfig";
import { accumulateStockDailyReturns, computeCumulativeAndMdd, computeCagrPct, type DailyStockReturns } from "@/lib/strategyBacktestSummary";
import { computeIndexDailyReturnsPct, simulateUniverseMonthlyRebalance, computeMonthlyRebalanceDates } from "@/lib/benchmarkSummary";
import { computeEffectiveBuyPrice, computeEffectiveSellPrice, computeCostAdjustedReturnPct } from "@/lib/transactionCost";
import { buildCtx, genTrades, PERIOD_START, TODAY, CAP_EOK, type Ctx } from "./research-ma-lab";

// ---- 사전 등록 상수 (research/audit-peg-prereg.md) ----
// 재현 게이트(research/audit-peg-prereg-addendum.md): 기준일 실행일 연환산 CAGR 5.89 ±0.02%p, MDD 29.3 ±0.1%p, 거래 700~714건.
const REPRO_REF = { cagr: 5.89, cagrTol: 0.02, mdd: 29.3, mddTol: 0.1, tradesMin: 700, tradesMax: 714, endDate: "2026-10-09" };
const PEG_RULE: StrategyRule = { rule_type: "peg_lynch", rule_params: {} };
const V3_NEAR_HIGH_GAP = -0.1829;
const V3_NEAR_HIGH_BARS = 252;
const ENDED_GRACE_DAYS = 14;
const FETCH_CONCURRENCY = 10;
const EXCLUDE_KS = [1, 5, 10];
const TOP_TRADES = 5;
const P1_MAX_LATE_RATIO = 0.01;
const P4_PASS_K = 5;
const P5_MAX_DROP_PP = 1.5;
const MS_DAY = 86_400_000;

interface PricePoint { tradeDate: string; closePrice: number }
type Cat = "청산" | "데이터 끝 강제청산" | "미청산 평가";
interface TR { code: string; buyDate: string; sellDate: string; ret: number; cat: Cat; eIdx: number; sIdx: number; days: { d: string; r: number }[] }
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
const dayDiff = (a: string, b: string): number => (Date.parse(b) - Date.parse(a)) / MS_DAY;
const endCap = (e: string): string => (e > TODAY ? TODAY : e);
const f2 = (x: number): string => (Number.isFinite(x) ? x.toFixed(2) : "-");
const mean = (v: number[]): number => (v.length ? v.reduce((a, x) => a + x, 0) / v.length : NaN);
const median = (v: number[]): number => { if (!v.length) return NaN; const s = [...v].sort((a, b) => a - b); const h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
function pctile(v: number[], p: number): number {
  if (!v.length) return NaN;
  const s = [...v].sort((a, b) => a - b), x = (p / 100) * (s.length - 1), lo = Math.floor(x), hi = Math.ceil(x);
  return s[lo] + (s[hi] - s[lo]) * (x - lo);
}
const ox = (b: boolean): string => (b ? "O" : "X");
let CAL: string[] = [];

/** 일별 수익률(%) 시계열 → [start, end] 구간 CAGR/MDD. exclusiveStart면 start 당일 수익률은 제외(그 날 종가에 진입한 것으로 보고 다음 날부터). */
function seriesMetrics(dates: string[], rets: number[], start: string, end: string, exclusiveStart = false) {
  const r = rets.filter((_, i) => (exclusiveStart ? dates[i] > start : dates[i] >= start) && dates[i] <= end);
  const { totalReturnPct, mddPct } = computeCumulativeAndMdd(r);
  return { cagr: computeCagrPct(totalReturnPct, start, endCap(end)), mdd: mddPct, total: totalReturnPct };
}
const seriesYear = (dates: string[], rets: number[], y: number, after?: string): number =>
  computeCumulativeAndMdd(rets.filter((_, i) => dates[i].startsWith(`${y}-`) && (!after || dates[i] > after))).totalReturnPct;
function bookDaily(b: Book): number[] {
  return CAL.map((d) => { const c = b.cnt.get(d) ?? 0; return c === 0 ? 0 : ((b.sum.get(d) ?? 0) / c) * 100; });
}

// ---- 운영 computePegLynchStates 복제(lib/backtest.ts, 비공개 함수) — 커버리지 집계와 거래 상태 일치 확인용 ----
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

function nearHighOk(ctx: Ctx, e: number): boolean {
  let hi = -Infinity;
  for (let j = Math.max(0, e - (V3_NEAR_HIGH_BARS - 1)); j <= e; j++) if (ctx.prices[j].high > hi) hi = ctx.prices[j].high;
  return ctx.prices[e].close / hi - 1 > V3_NEAR_HIGH_GAP;
}

/** 신호 인덱스 e,s를 shift 거래일 뒤 종가에 체결(감사 v3 스크립트 makeTrade와 같은 규칙). */
function delayedTrade(code: string, prices: DailyPrice[], e: number, s0: number, shift: number, cat: Cat): TR | null {
  const n = prices.length;
  const b = e + shift, s = Math.min(s0 + shift, n - 1);
  if (b >= n || s <= b || !(prices[b].close > 0) || !(prices[s].close > 0)) return null;
  const days: { d: string; r: number }[] = [];
  for (let i = b + 1; i <= s; i++) {
    if (prices[i].date < PERIOD_START) continue;
    if (!(prices[i - 1].close > 0) || !(prices[i].close > 0)) return null;
    let m = prices[i].close / prices[i - 1].close;
    if (i === b + 1) m /= computeEffectiveBuyPrice(prices[b].close) / prices[b].close;
    if (i === s) m *= computeEffectiveSellPrice(prices[s].close, prices[s].date, "KR") / prices[s].close;
    days.push({ d: prices[i].date, r: m - 1 });
  }
  return { code, buyDate: prices[b].date, sellDate: prices[s].date, ret: computeCostAdjustedReturnPct(prices[b].close, prices[s].close, prices[s].date, "KR"), cat, eIdx: b, sIdx: s, days };
}

// ---- D4(유니버스 시총가중) — research/baseline-decomposition-prereg.md 정의 그대로 ----
interface Sk { code: string; dates: string[]; close: Float64Array; mcap: Float64Array; avgTv: Float64Array; idx: Map<string, number> }
function simulateD4(stocks: Sk[], cal: string[]): { dates: string[]; ret: number[] } {
  const byCode = new Map(stocks.map((s) => [s.code, s]));
  const endedBefore = new Date(Date.parse(cal[cal.length - 1]) - ENDED_GRACE_DAYS * MS_DAY).toISOString().slice(0, 10);
  const buyRate = computeEffectiveBuyPrice(1) - 1;
  const rebal = new Set<string>();
  for (let k = 0; k + 1 < cal.length; k++) if (cal[k].slice(0, 7) !== cal[k + 1].slice(0, 7) && cal[k] >= PERIOD_START) rebal.add(cal[k]);
  let cash = 1, prevV = 1;
  const pos = new Map<string, { val: number; last: number }>();
  const out = { dates: [] as string[], ret: [] as number[] };
  for (const d of cal) {
    if (d < PERIOD_START) continue;
    const sellRate = 1 - computeEffectiveSellPrice(1, d, "KR");
    for (const [code, p] of [...pos.entries()]) {
      const sk = byCode.get(code)!;
      const i = sk.idx.get(d);
      if (i !== undefined) { p.val *= sk.close[i] / p.last; p.last = sk.close[i]; }
      else if (sk.dates[sk.dates.length - 1] < d && sk.dates[sk.dates.length - 1] < endedBefore) { cash += p.val * (1 - sellRate); pos.delete(code); }
    }
    if (rebal.has(d)) {
      const V = cash + [...pos.values()].reduce((a, p) => a + p.val, 0);
      const el: { sk: Sk; mcap: number }[] = [];
      for (const sk of stocks) {
        const i = sk.idx.get(d);
        if (i === undefined || i < 1 || !(sk.mcap[i - 1] >= CAP_EOK) || !(sk.avgTv[i] >= PIT_MIN_AVG_TRADING_VALUE_WON)) continue;
        el.push({ sk, mcap: sk.mcap[i] });
      }
      const tot = el.reduce((a, x) => a + x.mcap, 0);
      const tg = new Map(el.map((x) => [x.sk.code, x.mcap / tot]));
      let buyN = 0, sellN = 0;
      for (const [code, p] of pos) if (!tg.has(code)) sellN += p.val;
      for (const [code, w] of tg) { const diff = w * V - (pos.get(code)?.val ?? 0); if (diff > 0) buyN += diff; else sellN += -diff; }
      const C = buyN * buyRate + sellN * sellRate, scale = V > 0 ? (V - C) / V : 1;
      pos.clear();
      let inv = 0;
      for (const [code, w] of tg) { const sk = byCode.get(code)!; const val = w * V * scale; pos.set(code, { val, last: sk.close[sk.idx.get(d)!] }); inv += val; }
      cash = V - C - inv;
    }
    const V = cash + [...pos.values()].reduce((a, p) => a + p.val, 0);
    out.dates.push(d); out.ret.push((V / prevV - 1) * 100);
    prevV = V;
  }
  return out;
}

export interface FundLoad { series: FundamentalsSeries; ls: ListedSharesByFiscalYear }
export interface StudyInput {
  series: Map<string, StockDailyPriceRow[]>;
  kospi: PricePoint[];
  loadFund: (code: string, listedSharesOnOrBefore: (code: string, date: string) => number | null) => Promise<FundLoad>;
  reproGate: boolean;
}

async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) { const i = next++; if (i >= items.length) return; await worker(items[i]); }
  }));
}

export async function runStudy(inp: StudyInput): Promise<{ ok: boolean }> {
  const { series, kospi } = inp;
  const calSet = new Set<string>();
  let globalLast = "";
  for (const rows of series.values()) {
    for (const r of rows) if (r.tradeDate >= PERIOD_START) calSet.add(r.tradeDate);
    if (rows.length && rows[rows.length - 1].tradeDate > globalLast) globalLast = rows[rows.length - 1].tradeDate;
  }
  CAL = [...calSet].sort();
  const endedBefore = new Date(Date.parse(globalLast) - ENDED_GRACE_DAYS * MS_DAY).toISOString().slice(0, 10);
  const rebalanceDates = computeMonthlyRebalanceDates(CAL);
  const monthEnds = new Set<string>();
  for (let k = 0; k + 1 < CAL.length; k++) if (CAL[k].slice(0, 7) !== CAL[k + 1].slice(0, 7)) monthEnds.add(CAL[k]);
  console.log(`거래일 캘린더 ${CAL.length}일 ${CAL[0]}~${CAL[CAL.length - 1]}, 종료 판정 기준일 ${endedBefore}`);

  const pegBook = newBook(), pegDelayed = newBook(), v3Book = newBook();
  const stocks: Sk[] = [];
  const pricesByStock = new Map<string, { date: string; close: number }[]>();
  const liquidity = new Map<string, Map<string, number>>();
  const cover = new Map<string, { N: number; a: number; b: number; c: number; d: number }>();
  const fyCount = new Map<number, number>();
  const lagDays: number[] = [];
  let annualRows = 0, dividendRows = 0, fundStocks = 0, fundFail = 0, rceptNoMismatch = 0, negativeLag = 0, minRcept = "9999";
  let minFy = 9999;
  interface P1Rec { late: boolean; sameDay: boolean; lag: number; stateOk: boolean }
  const p1: P1Rec[] = [];
  const codes = [...series.keys()];

  await runWithConcurrency(codes, FETCH_CONCURRENCY, async (code) => {
    const rows = series.get(code)!;
    series.delete(code);
    const ctx = buildCtx(code, rows);
    const prices = ctx.prices;
    const idx = new Map(prices.map((p, i) => [p.date, i]));
    stocks.push({ code, dates: prices.map((p) => p.date), close: Float64Array.from(ctx.closes), mcap: Float64Array.from(rows.map((r) => r.marketCapEok)), avgTv: ctx.avgTv, idx });
    pricesByStock.set(code, prices.map((p) => ({ date: p.date, close: p.close })));
    const lq = new Map<string, number>();
    for (const d of rebalanceDates) {
      const i = idx.get(d);
      if (i !== undefined && Number.isFinite(ctx.avgTv[i]) && rows[i].marketCapEok >= CAP_EOK) lq.set(d, ctx.avgTv[i]);
    }
    liquidity.set(code, lq);
    if (ctx.goldens.length > 0) {
      for (const t of genTrades(ctx, { name: "v3", entryFilter: (c, e) => nearHighOk(c, e) })) {
        const tmp: DailyStockReturns = new Map();
        accumulateStockDailyReturns(tmp, new Map(), code, prices, [t], PERIOD_START, "KR", true);
        addTrade(v3Book, { code, buyDate: t.buyDate, sellDate: t.sellDate, ret: t.returnPct, cat: "청산", eIdx: t.eIdx, sIdx: t.sIdx, days: [...tmp.entries()].map(([d, es]) => ({ d, r: es[0].returnPct })) });
      }
    }
    const entryAllowed = (date: string): boolean => {
      const i = idx.get(date);
      return i !== undefined && ctx.avgTv[i] >= PIT_MIN_AVG_TRADING_VALUE_WON && rows[i].marketCapEok >= CAP_EOK;
    };
    let ever = false;
    for (let i = 0; i < prices.length; i++) if (prices[i].date >= PERIOD_START && entryAllowed(prices[i].date)) { ever = true; break; }
    if (!ever) return;

    let fl: FundLoad;
    try {
      fl = await inp.loadFund(code, (_c, date) => pickListedSharesOnOrBefore(rows, date, DEFAULT_ON_OR_BEFORE_LOOKBACK_DAYS));
    } catch (e) {
      fundFail++;
      console.error(`    ${code} 재무 조회 실패(peg_lynch만 영향): ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    fundStocks++;
    annualRows += fl.series.annual.length;
    dividendRows += fl.series.dividends.length;
    for (const a of fl.series.annual) {
      fyCount.set(a.fiscalYear, (fyCount.get(a.fiscalYear) ?? 0) + 1);
      if (a.fiscalYear < minFy) minFy = a.fiscalYear;
      if (a.rceptDate < minRcept) minRcept = a.rceptDate;
      if (a.rceptNo.slice(0, 8) !== a.rceptDate.replace(/-/g, "")) rceptNoMismatch++;
      const lag = dayDiff(`${a.fiscalYear}-12-31`, a.rceptDate);
      lagDays.push(lag);
      if (lag < 0) negativeLag++;
    }
    const states = pegStates(prices, fl.series, fl.ls);
    // 월말 커버리지
    for (const d of monthEnds) {
      const i = idx.get(d);
      if (i === undefined || !(rows[i].marketCapEok >= CAP_EOK) || !(ctx.avgTv[i] >= PIT_MIN_AVG_TRADING_VALUE_WON)) continue;
      const c = cover.get(d) ?? cover.set(d, { N: 0, a: 0, b: 0, c: 0, d: 0 }).get(d)!;
      c.N++;
      if (pickFundamentalsAsOf(fl.series, d)) c.a++;
      if (selectEpsCagrFiscalYears(fl.series, d)) c.b++;
      if (states[i] !== undefined) c.c++;
      if (states[i] === true) c.d++;
    }
    // 운영 runBacktest 그대로
    const result = runBacktest(prices, PEG_RULE, PERIOD_START, fl.series, fl.ls, { market: "KR", entryAllowed, includeTransactionCosts: true });
    if (result.insufficientData || result.trades.length === 0) return;
    const lastDate = rows[rows.length - 1].tradeDate;
    for (const t of result.trades) {
      const e = idx.get(t.buyDate)!, s = idx.get(t.sellDate)!;
      const cat: Cat = !t.isForcedLiquidation ? "청산" : lastDate < endedBefore ? "데이터 끝 강제청산" : "미청산 평가";
      const tmp: DailyStockReturns = new Map();
      accumulateStockDailyReturns(tmp, new Map(), code, prices, [t], PERIOD_START, "KR", true);
      addTrade(pegBook, { code, buyDate: t.buyDate, sellDate: t.sellDate, ret: t.returnPct, cat, eIdx: e, sIdx: s, days: [...tmp.entries()].map(([d, es]) => ({ d, r: es[0].returnPct })) });
      const dl = delayedTrade(code, prices, e, s, 1, cat);
      if (dl) addTrade(pegDelayed, dl);
      // P1: 신호일에 판정에 쓰인 재무 행
      const fund = pickFundamentalsAsOf(fl.series, t.buyDate);
      const pair = selectEpsCagrFiscalYears(fl.series, t.buyDate);
      const used = [fund?.rceptDate, pair?.start.rceptDate, pair?.end.rceptDate].filter((x): x is string => !!x);
      p1.push({
        late: used.some((x) => x > t.buyDate), sameDay: used.some((x) => x === t.buyDate),
        lag: fund ? dayDiff(fund.rceptDate, t.buyDate) : NaN, stateOk: states[e] === true,
      });
    }
  });

  // ---- 0) 재현 ----
  const pegAll = pegBook.trades.filter((t) => t.buyDate >= PERIOD_START);
  const pegDaily = bookDaily(pegBook);
  const m0 = seriesMetrics(CAL, pegDaily, PERIOD_START, TODAY);
  const mRef = seriesMetrics(CAL, pegDaily, PERIOD_START, REPRO_REF.endDate);
  console.log(`\n=== 0) peg_lynch 재현 확인 ===`);
  console.log(`재무 조회 종목 ${fundStocks}개(실패 ${fundFail}), annual 행 ${annualRows}, dividend 행 ${dividendRows}, beta_price_history(KOSPI) 읽은 행 ${kospi.length}`);
  console.log(`하네스(기준일 ${REPRO_REF.endDate}): CAGR ${f2(mRef.cagr)}% | MDD ${mRef.mdd.toFixed(1)}% | 거래 ${pegAll.length}건`);
  console.log(`하네스(기준일 오늘 ${TODAY}): CAGR ${f2(m0.cagr)}% | MDD ${m0.mdd.toFixed(1)}%`);
  console.log(`기준: CAGR ${REPRO_REF.cagr}% ±${REPRO_REF.cagrTol}%p(기준일 실행일) | MDD ${REPRO_REF.mdd}% ±${REPRO_REF.mddTol}%p | 거래 ${REPRO_REF.tradesMin}~${REPRO_REF.tradesMax}건`);
  const match = Math.abs(m0.cagr - REPRO_REF.cagr) <= REPRO_REF.cagrTol + 1e-9 && Math.abs(m0.mdd - REPRO_REF.mdd) <= REPRO_REF.mddTol + 1e-9 && pegAll.length >= REPRO_REF.tradesMin && pegAll.length <= REPRO_REF.tradesMax;
  console.log(`재현 결과: ${match ? "일치" : "불일치"}`);
  if (inp.reproGate && !match) {
    console.log("재현이 어긋나 중단합니다. (원인 후보: 데이터 범위(연도 파일)·조정계수/재무 데이터 변경, 집계 구현 차이)");
    return { ok: false };
  }
  const firstBuy = pegAll.reduce((m, t) => (t.buyDate < m ? t.buyDate : m), "9999");
  console.log(`첫 매수일(신호일): ${firstBuy}`);

  // ---- P1 ----
  const lateN = p1.filter((x) => x.late).length, sameN = p1.filter((x) => x.sameDay).length;
  const stateBad = p1.filter((x) => !x.stateOk).length;
  const lags = p1.map((x) => x.lag).filter(Number.isFinite);
  console.log(`\n=== P1 재무 시점 ===`);
  console.log("판정에 쓰는 컬럼: stock_annual_fundamentals(fiscal_year, rcept_no, rcept_date, net_income_parent, fs_div) — PEG 판정에 net_income_parent, fs_div, rcept_date 사용(equity_parent는 PEG에 쓰이지 않음); 시세(close, listed_shares)");
  console.log("공시일 필드: rcept_date(YYYY-MM-DD), rcept_no 있음. 코드: lib/pointInTimeFundamentals.ts pickFundamentalsAsOf(rcept_date <= 조회일), lib/stockFundamentals.ts loadFundamentalsSeries(select/order rcept_date), lib/backtest.ts computePegLynchStates. 대체 규칙 사용 안 함.");
  console.log("| 항목 | 값 |");
  console.log("|---|---|");
  console.log(`| 검사한 거래 수 | ${p1.length} |`);
  console.log(`| 신호일보다 늦게 공시된 재무를 쓴 거래 | ${lateN} (${f2((lateN / Math.max(p1.length, 1)) * 100)}%) |`);
  console.log(`| 신호일과 같은 날 공시된 재무를 쓴 거래(참고) | ${sameN} (${f2((sameN / Math.max(p1.length, 1)) * 100)}%) |`);
  console.log(`| 신호일에 내 상태 재계산이 true가 아닌 거래(복제 일치 점검) | ${stateBad} |`);
  console.log(`| 신호일 − 최신 공시일 지연(일) 최소/5%/중앙값/95%/최대 | ${f2(Math.min(...lags))} / ${f2(pctile(lags, 5))} / ${f2(median(lags))} / ${f2(pctile(lags, 95))} / ${f2(Math.max(...lags))} |`);
  console.log(`| annual 행 수 | ${annualRows} |`);
  console.log(`| rcept_no 앞 8자리 ≠ rcept_date 인 행 | ${rceptNoMismatch} |`);
  console.log(`| 공시 지연(rcept_date − 회계연도 12-31) 최소/5%/중앙값/95%/최대(일) | ${f2(Math.min(...lagDays))} / ${f2(pctile(lagDays, 5))} / ${f2(median(lagDays))} / ${f2(pctile(lagDays, 95))} / ${f2(Math.max(...lagDays))} |`);
  console.log(`| 공시 지연 < 0 인 행 | ${negativeLag} |`);
  console.log(`읽은 행 수: 재무 조회 종목 ${fundStocks}개, stock_annual_fundamentals ${annualRows}행, stock_dividend_history ${dividendRows}행, beta_price_history(KOSPI) ${kospi.length}행`);

  // ---- P2 ----
  const years: number[] = [];
  for (let y = 2010; y <= Number(TODAY.slice(0, 4)); y++) years.push(y);
  console.log(`\n=== P2 커버리지 (연도별 월말 평균) ===`);
  console.log("| 연도 | 유니버스 종목 | (a) 재무 보유 | (b) EPS CAGR 연도쌍 | (c) PEG 판정 가능 | (d) 조건 충족 | 월말 수 |");
  console.log("|---|---|---|---|---|---|---|");
  for (const y of years) {
    const ds = [...cover.keys()].filter((d) => d.startsWith(`${y}-`));
    if (!ds.length) continue;
    const av = (k: "N" | "a" | "b" | "c" | "d"): string => mean(ds.map((d) => cover.get(d)![k])).toFixed(1);
    console.log(`| ${y} | ${av("N")} | ${av("a")} | ${av("b")} | ${av("c")} | ${av("d")} | ${ds.length} |`);
  }
  const firstBuyMonth = firstBuy.slice(0, 7);
  const before = [...cover.keys()].filter((d) => d.slice(0, 7) < firstBuyMonth).sort();
  const maxCBefore = Math.max(0, ...before.map((d) => cover.get(d)!.c));
  const firstC = [...cover.keys()].sort().find((d) => cover.get(d)!.c > 0);
  const firstD = [...cover.keys()].sort().find((d) => cover.get(d)!.d > 0);
  console.log(`재무 테이블(조회 종목 기준): 가장 이른 회계연도 ${minFy}, 가장 이른 공시일 ${minRcept}`);
  console.log(`회계연도별 보유 종목 수: ${[...fyCount.entries()].sort((a, b) => a[0] - b[0]).map(([y, n]) => `FY${y}: ${n}`).join(", ")}`);
  console.log(`첫 매수일 ${firstBuy} | 월말 기준 첫 PEG 판정 가능 날짜 ${firstC ?? "-"} | 월말 기준 첫 조건 충족 날짜 ${firstD ?? "-"} | 첫 매수 달(${firstBuyMonth}) 이전 월말 중 판정 가능 종목 수 최대 ${maxCBefore}`);

  // ---- P3 ----
  const uRets = simulateUniverseMonthlyRebalance(
    pricesByStock, CAL, PERIOD_START,
    (code, date) => (liquidity.get(code)?.get(date) ?? NaN) >= PIT_MIN_AVG_TRADING_VALUE_WON, true
  );
  const kp = kospi.filter((p) => p.tradeDate >= PERIOD_START);
  const kDates = kp.slice(1).map((p) => p.tradeDate);
  const kRets = computeIndexDailyReturnsPct(kp as never);
  const d4 = simulateD4(stocks, CAL);
  const v3Daily = bookDaily(v3Book);
  const rows3: [string, string[], number[]][] = [
    ["peg_lynch", CAL, pegDaily], ["유니버스 동일가중 월리밸", CAL, uRets], ["KOSPI(가격지수)", kDates, kRets],
    ["유니버스 시총가중(D4)", d4.dates, d4.ret], ["상한 없는 v3", CAL, v3Daily],
  ];
  console.log(`\n=== P3 같은 기간 비교: ${firstBuy} 이후 ~ ${TODAY} (시작일 당일 수익률 제외) ===`);
  console.log("| 구성 | CAGR % | MDD % |");
  console.log("|---|---|---|");
  const p3: Record<string, { cagr: number; mdd: number }> = {};
  for (const [n, d, r] of rows3) { const m = seriesMetrics(d, r, firstBuy, TODAY, true); p3[n] = m; console.log(`| ${n} | ${f2(m.cagr)} | ${f2(m.mdd)} |`); }
  const y0 = Number(firstBuy.slice(0, 4));
  const ys = years.filter((y) => y >= y0);
  console.log(`\n연도별 수익률 % (${y0}은 ${firstBuy} 이후 부분 연도)`);
  console.log("| 구성 | " + ys.join(" | ") + " |");
  console.log("|---|" + ys.map(() => "---").join("|") + "|");
  for (const [n, d, r] of rows3) console.log(`| ${n} | ${ys.map((y) => f2(seriesYear(d, r, y, y === y0 ? firstBuy : undefined))).join(" | ")} |`);

  // ---- P4 ----
  const holdT = pegAll.map((t) => t.sIdx - t.eIdx), holdC = pegAll.map((t) => dayDiff(t.buyDate, t.sellDate));
  const sinceDays = CAL.filter((d) => d > firstBuy);
  const concAll = CAL.reduce((a, d) => a + (pegBook.cnt.get(d) ?? 0), 0) / CAL.length;
  const concSince = sinceDays.reduce((a, d) => a + (pegBook.cnt.get(d) ?? 0), 0) / Math.max(sinceDays.length, 1);
  console.log(`\n=== P4 거래 통계·집중도 ===`);
  console.log("| 항목 | 값 |");
  console.log("|---|---|");
  console.log(`| 거래 수 | ${pegAll.length} |`);
  console.log(`| 평균 보유일(거래일 / 달력일) | ${mean(holdT).toFixed(1)} / ${mean(holdC).toFixed(1)} |`);
  console.log(`| 평균 동시 보유(2010~ 전체 거래일 / 첫 매수일 이후) | ${concAll.toFixed(1)} / ${concSince.toFixed(1)} |`);
  const sorted = [...pegAll].sort((a, b) => b.ret - a.ret || a.buyDate.localeCompare(b.buyDate));
  console.log("\n| 제외 | 2010~ CAGR % | 2010~ MDD % | 첫 매수일 이후 CAGR % | 첫 매수일 이후 MDD % | 남은 거래 |");
  console.log("|---|---|---|---|---|---|");
  let p4Cagr5 = NaN;
  for (const k of [0, ...EXCLUDE_KS]) {
    const b = k === 0 ? pegBook : withoutTrades(pegBook, (t) => sorted.slice(0, k).includes(t));
    const dly = bookDaily(b);
    const a = seriesMetrics(CAL, dly, PERIOD_START, TODAY), s = seriesMetrics(CAL, dly, firstBuy, TODAY, true);
    if (k === P4_PASS_K) p4Cagr5 = a.cagr;
    console.log(`| ${k === 0 ? "없음(기준)" : `상위 ${k}건`} | ${f2(a.cagr)} | ${f2(a.mdd)} | ${f2(s.cagr)} | ${f2(s.mdd)} | ${b.trades.filter((t) => t.buyDate >= PERIOD_START).length} |`);
  }
  console.log("\n최대 수익 거래 상위 5개");
  console.log("| 종목 | 진입일 | 청산일 | 분류 | 수익률 % |");
  console.log("|---|---|---|---|---|");
  for (const t of sorted.slice(0, TOP_TRADES)) console.log(`| ${t.code} | ${t.buyDate} | ${t.sellDate} | ${t.cat} | ${f2(t.ret * 100)} |`);

  // ---- P5 ----
  const dDaily = bookDaily(pegDelayed);
  const dA = seriesMetrics(CAL, dDaily, PERIOD_START, TODAY), dS = seriesMetrics(CAL, dDaily, firstBuy, TODAY, true);
  const bS = seriesMetrics(CAL, pegDaily, firstBuy, TODAY, true);
  console.log(`\n=== P5 체결 지연 (신호 다음 거래일 종가) ===`);
  console.log("| 체결 | 2010~ CAGR % | 2010~ MDD % | 거래 수 | 첫 매수일 이후 CAGR % | 첫 매수일 이후 MDD % |");
  console.log("|---|---|---|---|---|---|");
  console.log(`| 신호일 종가(기준) | ${f2(m0.cagr)} | ${f2(m0.mdd)} | ${pegAll.length} | ${f2(bS.cagr)} | ${f2(bS.mdd)} |`);
  console.log(`| 다음 거래일 종가 | ${f2(dA.cagr)} | ${f2(dA.mdd)} | ${pegDelayed.trades.filter((t) => t.buyDate >= PERIOD_START).length} | ${f2(dS.cagr)} | ${f2(dS.mdd)} |`);

  // ---- P6 ----
  console.log(`\n=== P6 (참고, 판정 제외) 미청산 평가 ===`);
  console.log("| 분류 | 건수 | 수익률 합 % | 평균 % | 중앙값 % |");
  console.log("|---|---|---|---|---|");
  for (const c of ["청산", "데이터 끝 강제청산", "미청산 평가"] as Cat[]) {
    const l = pegAll.filter((t) => t.cat === c).map((t) => t.ret * 100);
    console.log(`| ${c} | ${l.length} | ${f2(l.reduce((a, x) => a + x, 0))} | ${f2(mean(l))} | ${f2(median(l))} |`);
  }
  console.log("\n| 구성 | 2010~ CAGR % | 2010~ MDD % | 거래 수 | 첫 매수일 이후 CAGR % | 첫 매수일 이후 MDD % |");
  console.log("|---|---|---|---|---|---|");
  for (const [lab, b] of [["기준(제외 없음)", pegBook], ["미청산 평가 제외", withoutTrades(pegBook, (t) => t.cat === "미청산 평가")], ["미청산 평가 + 데이터 끝 강제청산 제외", withoutTrades(pegBook, (t) => t.cat !== "청산")]] as [string, Book][]) {
    const dly = bookDaily(b);
    const a = seriesMetrics(CAL, dly, PERIOD_START, TODAY), s = seriesMetrics(CAL, dly, firstBuy, TODAY, true);
    console.log(`| ${lab} | ${f2(a.cagr)} | ${f2(a.mdd)} | ${b.trades.filter((t) => t.buyDate >= PERIOD_START).length} | ${f2(s.cagr)} | ${f2(s.mdd)} |`);
  }

  // ---- 판정표 ----
  const peg3 = p3["peg_lynch"], uni3 = p3["유니버스 동일가중 월리밸"];
  const pass = {
    P1: p1.length > 0 && lateN / p1.length <= P1_MAX_LATE_RATIO,
    P2: maxCBefore === 0,
    P3: peg3.cagr > uni3.cagr && peg3.mdd <= uni3.mdd,
    P4: p4Cagr5 > 0,
    P5: m0.cagr - dA.cagr <= P5_MAX_DROP_PP,
  };
  console.log(`\n=== 사전 판정 기준 (O/X) ===`);
  console.log("| 항목 | 측정값 | 기준 | 결과 |");
  console.log("|---|---|---|---|");
  console.log(`| P1 | 늦은 재무 사용 ${lateN}/${p1.length} (${f2((lateN / Math.max(p1.length, 1)) * 100)}%) | <= ${P1_MAX_LATE_RATIO * 100}% | ${ox(pass.P1)} |`);
  console.log(`| P2 | 첫 매수 달 이전 월말 판정 가능 종목 최대 ${maxCBefore}개 | 0개 | ${ox(pass.P2)} |`);
  console.log(`| P3 | peg ${f2(peg3.cagr)}/${f2(peg3.mdd)} vs 유니버스 동일가중 ${f2(uni3.cagr)}/${f2(uni3.mdd)} (CAGR/MDD) | CAGR > 이고 MDD <= | ${ox(pass.P3)} |`);
  console.log(`| P4 | 상위 ${P4_PASS_K}건 제외 2010~ CAGR ${f2(p4Cagr5)} | > 0 | ${ox(pass.P4)} |`);
  console.log(`| P5 | 하락폭 ${f2(m0.cagr - dA.cagr)}%p | <= ${P5_MAX_DROP_PP}%p | ${ox(pass.P5)} |`);
  const oc = Object.values(pass).filter(Boolean).length;
  console.log(`O 개수: ${oc}/5 → 종합 표기: ${oc >= 4 ? "신뢰 가능(조건부)" : oc >= 2 ? "불확실" : "신뢰 어려움"}`);
  console.log("\n감사(시도 횟수에 포함하지 않음)\n완료");
  return { ok: true };
}

async function main(): Promise<void> {
  console.log(`peg_lynch 재검증 감사 시작(읽기 전용): ${new Date().toISOString()}`);
  const adjustments = await loadAppliedAdjustments();
  console.log(`조정계수 적용 대상: ${adjustments.size}종목`);
  const series = await loadAllStockSeriesFromParquet(2010, new Date().getUTCFullYear(), adjustments);
  console.log(`종목 ${series.size}개 로드, heap ${(process.memoryUsage().heapUsed / 1048576).toFixed(0)}MB`);
  const kospi = await getIndexPriceSeries("KOSPI", PERIOD_START, TODAY);
  const loadFund: StudyInput["loadFund"] = async (code, lsFn) => {
    const r = await loadFundamentalsSeriesWithListedShares(code, lsFn);
    return { series: r.series, ls: r.listedSharesByFiscalYear };
  };
  const { ok } = await runStudy({ series, kospi, loadFund, reproGate: true });
  if (!ok) process.exit(2);
}
if (process.argv[1] && process.argv[1].endsWith("research-audit-peg.ts")) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
