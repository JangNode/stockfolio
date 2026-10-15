/**
 * [임시 연구 — 병합 금지, 읽기 전용] 재무 요인 순위 전략 8종(F1~F7, F6L) + 기준선(2017-04~) 실행기.
 * 사전 등록: research/factor-strategies-prereg.md. 판정·추천 없이 숫자만 출력한다.
 * DB는 stock_annual_fundamentals / stock_dividend_history / beta_price_history / stock_price_adjustment_events 조회만(쓰기 없음).
 */
import { getIndexPriceSeries } from "@/lib/betaPriceHistoryStorage";
import { DEFAULT_ON_OR_BEFORE_LOOKBACK_DAYS, loadAllStockSeriesFromParquet, type StockDailyPriceRow } from "@/lib/stockDailyPricesStorage";
import { loadAppliedAdjustments } from "@/lib/stockPriceAdjustmentsStorage";
import { applyAdjustmentsInPlace, type AppliedAdjustment } from "@/lib/priceAdjustment";
import { loadFundamentalsSeriesWithListedShares } from "@/lib/stockFundamentals";
import {
  pickFundamentalsAsOf, pickFundamentalsVisibleAsOf, pickDividendsPaidAsOf, computeValuationFromSeries, type FundamentalsSeries,
} from "@/lib/pointInTimeFundamentals";
import { selectEpsCagrFiscalYears, computeEpsCagrFromResolvedShares, computePeg, type ListedSharesByFiscalYear } from "@/lib/pegRatio";
import { PEG_MAX_RATIO } from "@/lib/pegConfig";
import { runBacktest, type StrategyRule } from "@/lib/backtest";
import { pickListedSharesOnOrBefore } from "@/lib/pitUniverse";
import { PIT_MIN_AVG_TRADING_VALUE_WON } from "@/lib/strategyBacktestSummaryConfig";
import { accumulateStockDailyReturns, computeCumulativeAndMdd, computeCagrPct, type DailyStockReturns } from "@/lib/strategyBacktestSummary";
import { computeIndexDailyReturnsPct, simulateUniverseMonthlyRebalance, computeMonthlyRebalanceDates } from "@/lib/benchmarkSummary";
import { computeEffectiveBuyPrice, computeEffectiveSellPrice } from "@/lib/transactionCost";
import { buildCtx, genTrades, PERIOD_START, TODAY, CAP_EOK, type Ctx } from "./research-ma-lab";

// ---- 사전 등록 상수 (research/factor-strategies-prereg.md) ----
const EVAL_START = "2017-04-01";
const LEARN_END = "2021-12-31";
const CONFIRM_START = "2022-01-01";
const N_HOLD = 20;
const U2_TOP_N = 100;
const EOK_TO_WON = 1e8;
const DIVIDEND_WINDOW_DAYS = 365;
const FUND_EVER_ELIGIBLE_FROM = "2016-01-01";
const FUND_CONCURRENCY = 10;
const ENDED_GRACE_DAYS = 14;
const V3_NEAR_HIGH_GAP = -0.1829;
const V3_NEAR_HIGH_BARS = 252;
const PEG_RULE: StrategyRule = { rule_type: "peg_lynch", rule_params: {} };
const PRIOR_ATTEMPTS = 54;
const REF = { v3: "6.36 / 53.31 / 2335건", peg: "5.89 / 29.3 / 약 707건" };
const MS_DAY = 86_400_000;

export type Fid = "F1" | "F2" | "F3" | "F4" | "F5" | "F6" | "F7" | "F6L";
const FIDS: Fid[] = ["F1", "F2", "F3", "F4", "F5", "F6", "F7", "F6L"];
const FNAME: Record<Fid, string> = {
  F1: "F1 낮은 PER", F2: "F2 낮은 PBR", F3: "F3 높은 ROE", F4: "F4 순이익 성장률", F5: "F5 배당수익률", F6: "F6 합성(U1)", F7: "F7 PEG 순위", F6L: "F6L 합성(U2 시총 상위 100)",
};
export type Base = "D1" | "D2" | "D4";
const BNAME: Record<Base, string> = { D1: "D1 상위20 동일가중", D2: "D2 상위20 시총가중", D4: "D4 U1 전체 시총가중" };

interface PricePoint { tradeDate: string; closePrice: number }
interface Sk { code: string; dates: string[]; close: Float64Array; rawClose: Float64Array; mcap: Float64Array; listed: Float64Array; avgTv: Float64Array; idx: Map<string, number> }
interface Tgt { code: string; w: number }
interface Rec { sk: Sk; i: number; per: number; pbr: number; roe: number; growth: number; dy: number; peg: number }
export interface TR { code?: string; buyDate: string; sellDate: string; ret: number; days: { d: string; r: number }[] }
interface Book { sum: Map<string, number>; cnt: Map<string, number>; trades: TR[] }
const newBook = (): Book => ({ sum: new Map(), cnt: new Map(), trades: [] });
function addTrade(b: Book, t: TR): void {
  b.trades.push(t);
  for (const { d, r } of t.days) { b.sum.set(d, (b.sum.get(d) ?? 0) + r); b.cnt.set(d, (b.cnt.get(d) ?? 0) + 1); }
}
function windowBook(trades: TR[], from: string): Book {
  const b = newBook();
  for (const t of trades) if (t.buyDate >= from) addTrade(b, t);
  return b;
}

const dayDiff = (a: string, b: string): number => (Date.parse(b) - Date.parse(a)) / MS_DAY;
const endCap = (e: string): string => (e > TODAY ? TODAY : e);
const f2 = (x: number): string => (Number.isFinite(x) ? x.toFixed(2) : "-");
const mean = (v: number[]): number => (v.length ? v.reduce((a, x) => a + x, 0) / v.length : NaN);
const byCode = (a: { code: string }, b: { code: string }): number => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
const addDays = (d: string, n: number): string => new Date(Date.parse(d) + n * MS_DAY).toISOString().slice(0, 10);
let CAL: string[] = [];

function nearHighOk(ctx: Ctx, e: number): boolean {
  let hi = -Infinity;
  for (let j = Math.max(0, e - (V3_NEAR_HIGH_BARS - 1)); j <= e; j++) if (ctx.prices[j].high > hi) hi = ctx.prices[j].high;
  return ctx.prices[e].close / hi - 1 > V3_NEAR_HIGH_GAP;
}

function seriesMetrics(dates: string[], rets: number[], start: string, end: string) {
  const r = rets.filter((_, i) => dates[i] >= start && dates[i] <= end);
  const { totalReturnPct, mddPct } = computeCumulativeAndMdd(r);
  return { cagr: computeCagrPct(totalReturnPct, start, endCap(end)), mdd: mddPct };
}
const seriesYear = (dates: string[], rets: number[], y: number): number =>
  computeCumulativeAndMdd(rets.filter((_, i) => dates[i].startsWith(`${y}-`))).totalReturnPct;
function bookDaily(b: Book): number[] {
  return CAL.map((d) => { const c = b.cnt.get(d) ?? 0; return c === 0 ? 0 : ((b.sum.get(d) ?? 0) / c) * 100; });
}

// ---- 월말 리밸런싱 포트폴리오 엔진 (research-baseline-decomposition.ts 와 같은 체결·비용 규칙, 시작일 파라미터화) ----
export interface SimOut { dates: string[]; ret: number[]; hold: number[]; cashShare: number[]; turn: { d: string; v: number }[]; orders: { d: string; n: number }[] }
function simulate(targetsAt: (d: string) => Tgt[], stocks: Sk[], cal: string[], start: string): SimOut {
  const byC = new Map(stocks.map((s) => [s.code, s]));
  const endedBefore = new Date(Date.parse(cal[cal.length - 1]) - ENDED_GRACE_DAYS * MS_DAY).toISOString().slice(0, 10);
  const buyRate = computeEffectiveBuyPrice(1) - 1;
  const rebal = new Set<string>();
  for (let k = 0; k + 1 < cal.length; k++) if (cal[k].slice(0, 7) !== cal[k + 1].slice(0, 7) && cal[k] >= start) rebal.add(cal[k]);
  let cash = 1, prevV = 1;
  const pos = new Map<string, { val: number; last: number }>();
  const out: SimOut = { dates: [], ret: [], hold: [], cashShare: [], turn: [], orders: [] };
  for (const d of cal) {
    if (d < start) continue;
    const sellRate = 1 - computeEffectiveSellPrice(1, d, "KR");
    let liq = 0;
    for (const [code, p] of [...pos.entries()]) {
      const sk = byC.get(code)!;
      const i = sk.idx.get(d);
      if (i !== undefined) { p.val *= sk.close[i] / p.last; p.last = sk.close[i]; }
      else if (sk.dates[sk.dates.length - 1] < d && sk.dates[sk.dates.length - 1] < endedBefore) { cash += p.val * (1 - sellRate); pos.delete(code); liq++; }
    }
    if (liq) out.orders.push({ d, n: liq });
    if (rebal.has(d)) {
      const V = cash + [...pos.values()].reduce((a, p) => a + p.val, 0);
      const tg = targetsAt(d);
      const tgMap = new Map(tg.map((x) => [x.code, x.w]));
      let buyN = 0, sellN = 0, n = 0;
      for (const [code, p] of pos) if (!tgMap.has(code)) { sellN += p.val; n++; }
      for (const { code, w } of tg) {
        const diff = w * V - (pos.get(code)?.val ?? 0);
        if (diff > 0) buyN += diff; else sellN += -diff;
        if (diff !== 0) n++;
      }
      const C = buyN * buyRate + sellN * sellRate;
      const scale = V > 0 ? (V - C) / V : 1;
      pos.clear();
      let inv = 0;
      for (const { code, w } of tg) { const sk = byC.get(code)!; const val = w * V * scale; pos.set(code, { val, last: sk.close[sk.idx.get(d)!] }); inv += val; }
      cash = V - C - inv;
      out.turn.push({ d, v: V > 0 ? (buyN + sellN) / 2 / V : 0 });
      out.orders.push({ d, n });
    }
    const V = cash + [...pos.values()].reduce((a, p) => a + p.val, 0);
    out.dates.push(d); out.ret.push((V / prevV - 1) * 100); out.hold.push(pos.size); out.cashShare.push(V > 0 ? cash / V : 1);
    prevV = V;
  }
  return out;
}
function sliceStats(o: SimOut, s: string, e: string) {
  const m = seriesMetrics(o.dates, o.ret, s, e);
  const idxs = o.dates.map((d, i) => (d >= s && d <= e ? i : -1)).filter((i) => i >= 0);
  const years = Math.max(dayDiff(s, endCap(e)) / 365.25, 1e-9);
  const avg = (v: number[]): number => (idxs.length ? idxs.reduce((a, i) => a + v[i], 0) / idxs.length : 0);
  return {
    ...m,
    turnover: (o.turn.filter((x) => x.d >= s && x.d <= e).reduce((a, x) => a + x.v, 0) / years) * 100,
    hold: avg(o.hold), cash: avg(o.cashShare) * 100,
    trades: o.orders.filter((x) => x.d >= s && x.d <= e).reduce((a, x) => a + x.n, 0),
  };
}

const SLICES: [string, string, string][] = [["전체 2017-04~", EVAL_START, TODAY], ["학습 2017-04~2021-12", EVAL_START, LEARN_END], ["확인 2022-01~", CONFIRM_START, TODAY]];

export interface FundLoad { series: FundamentalsSeries; ls: ListedSharesByFiscalYear }
export interface StudyInput {
  series: Map<string, StockDailyPriceRow[]>; // 원본(조정 전)
  adjustments: Map<string, AppliedAdjustment[]>;
  kospi: PricePoint[];
  loadFund: (code: string, lsFn: (code: string, date: string) => number | null) => Promise<FundLoad>;
}

async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) { const i = next++; if (i >= items.length) return; await worker(items[i]); }
  }));
}

export interface StudyResult {
  calEval: string[]; cal: string[];
  sims: Map<Fid, SimOut>; baseSims: Map<Base, SimOut>;
  kDates: string[]; kRets: number[];
  v3Daily: number[]; pegDaily: number[]; pegTrades: TR[]; pegCnt: Map<string, number>;
  fundRows: { stocks: number; annual: number; dividend: number; kospi: number };
}

export async function runStudy(inp: StudyInput): Promise<StudyResult> {
  const { series, kospi } = inp;
  const calSet = new Set<string>();
  let globalLast = "";
  for (const rows of series.values()) {
    for (const r of rows) if (r.tradeDate >= PERIOD_START) calSet.add(r.tradeDate);
    if (rows.length && rows[rows.length - 1].tradeDate > globalLast) globalLast = rows[rows.length - 1].tradeDate;
  }
  CAL = [...calSet].sort();
  const calEval = CAL.filter((d) => d >= EVAL_START);
  const endedBefore = new Date(Date.parse(globalLast) - ENDED_GRACE_DAYS * MS_DAY).toISOString().slice(0, 10);
  const rebalEval = computeMonthlyRebalanceDates(calEval);
  console.log(`거래일 캘린더 ${CAL.length}일 ${CAL[0]}~${CAL[CAL.length - 1]}`);

  const stocks: Sk[] = [];
  const fundBy = new Map<string, FundLoad>();
  const pricesByStock = new Map<string, { date: string; close: number }[]>();
  const liquidity = new Map<string, Map<string, number>>();
  const v3Trades: TR[] = [];
  const pegTrades2010: TR[] = [];
  const pegBook2017 = newBook();
  let annualRows = 0, dividendRows = 0, fundFail = 0;
  const codes = [...series.keys()];

  await runWithConcurrency(codes, FUND_CONCURRENCY, async (code) => {
    const raw = series.get(code)!;
    series.delete(code);
    const adjList = inp.adjustments.get(code);
    let adj = raw;
    if (adjList) { adj = raw.map((r) => ({ ...r })); applyAdjustmentsInPlace(adj, adjList); }
    const ctx = buildCtx(code, adj);
    const prices = ctx.prices;
    const sk: Sk = {
      code, dates: prices.map((p) => p.date), close: Float64Array.from(ctx.closes), rawClose: Float64Array.from(raw.map((r) => r.closePrice)),
      mcap: Float64Array.from(raw.map((r) => r.marketCapEok)), listed: Float64Array.from(adj.map((r) => r.listedShares)), avgTv: ctx.avgTv,
      idx: new Map(prices.map((p, i) => [p.date, i])),
    };
    stocks.push(sk);
    pricesByStock.set(code, prices.map((p) => ({ date: p.date, close: p.close })));
    const lq = new Map<string, number>();
    for (const d of rebalEval) {
      const i = sk.idx.get(d);
      if (i !== undefined && Number.isFinite(ctx.avgTv[i]) && raw[i].marketCapEok >= CAP_EOK) lq.set(d, ctx.avgTv[i]);
    }
    liquidity.set(code, lq);
    // v3 (2010 시작으로 생성 후 기간별로 자름)
    if (ctx.goldens.length > 0) {
      for (const t of genTrades(ctx, { name: "v3", entryFilter: (c, e) => nearHighOk(c, e) })) {
        const tmp: DailyStockReturns = new Map();
        accumulateStockDailyReturns(tmp, new Map(), code, prices, [t], PERIOD_START, "KR", true);
        v3Trades.push({ buyDate: t.buyDate, sellDate: t.sellDate, ret: t.returnPct, days: [...tmp.entries()].map(([d, es]) => ({ d, r: es[0].returnPct })) });
      }
    }
    // 재무 조회 대상: 2016-01-01 이후 한 번이라도 U1 적격
    let ever = false;
    for (let i = 1; i < prices.length; i++) {
      if (prices[i].date >= FUND_EVER_ELIGIBLE_FROM && sk.mcap[i - 1] >= CAP_EOK && ctx.avgTv[i] >= PIT_MIN_AVG_TRADING_VALUE_WON) { ever = true; break; }
    }
    if (!ever) return;
    let fl: FundLoad;
    try {
      fl = await inp.loadFund(code, (_c, date) => pickListedSharesOnOrBefore(adj, date, DEFAULT_ON_OR_BEFORE_LOOKBACK_DAYS));
    } catch (e) {
      fundFail++;
      console.error(`    ${code} 재무 조회 실패: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    fundBy.set(code, fl);
    annualRows += fl.series.annual.length;
    dividendRows += fl.series.dividends.length;
    // peg_lynch 기준선 (운영 runBacktest 그대로; 진입 허용 = 신호일 시총(당일) 5천억 + 거래대금 5억)
    const entryAllowed = (date: string): boolean => {
      const i = sk.idx.get(date);
      return i !== undefined && ctx.avgTv[i] >= PIT_MIN_AVG_TRADING_VALUE_WON && sk.mcap[i] >= CAP_EOK;
    };
    for (const win of [PERIOD_START, EVAL_START]) {
      const result = runBacktest(prices, PEG_RULE, win, fl.series, fl.ls, { market: "KR", entryAllowed, includeTransactionCosts: true });
      if (result.insufficientData || result.trades.length === 0) continue;
      for (const t of result.trades) {
        const tmp: DailyStockReturns = new Map();
        accumulateStockDailyReturns(tmp, new Map(), code, prices, [t], win, "KR", true);
        const tr: TR = { code, buyDate: t.buyDate, sellDate: t.sellDate, ret: t.returnPct, days: [...tmp.entries()].map(([d, es]) => ({ d, r: es[0].returnPct })) };
        if (win === PERIOD_START) pegTrades2010.push(tr); else addTrade(pegBook2017, tr);
      }
    }
  });
  stocks.sort(byCode);
  void endedBefore;

  // ---- 요인 계산 ----
  const recCache = new Map<string, { u1: Rec[]; u2: Rec[] }>();
  function evalRec(sk: Sk, i: number, t: string): Rec {
    const rec: Rec = { sk, i, per: NaN, pbr: NaN, roe: NaN, growth: NaN, dy: NaN, peg: NaN };
    const fl = fundBy.get(sk.code);
    if (!fl) return rec;
    const fund = pickFundamentalsAsOf(fl.series, t);
    const M = sk.mcap[i] * EOK_TO_WON;
    if (fund) {
      const ni = fund.netIncomeParent, eq = fund.equityParent;
      if (ni !== null && ni > 0) rec.per = M / ni;
      if (eq !== null && eq > 0) rec.pbr = M / eq;
      if (ni !== null && ni > 0 && eq !== null && eq > 0) rec.roe = ni / eq;
      const prev = pickFundamentalsVisibleAsOf(fl.series, t).find((r) => r.fiscalYear === fund.fiscalYear - 1);
      if (prev && ni !== null && ni > 0 && prev.netIncomeParent !== null && prev.netIncomeParent > 0 && prev.fsDiv === fund.fsDiv) rec.growth = ni / prev.netIncomeParent - 1;
      // PEG (운영 computePegLynchStates 와 같은 정의)
      const ls = sk.listed[i];
      if (ni !== null && ni > 0 && ls > 0) {
        const { per } = computeValuationFromSeries(sk.close[i], ls, fund);
        const pair = selectEpsCagrFiscalYears(fl.series, t);
        if (pair) {
          const peg = computePeg(per, computeEpsCagrFromResolvedShares(pair, fl.ls));
          if (peg !== null && peg <= PEG_MAX_RATIO) rec.peg = peg;
        }
      }
    }
    const divs = pickDividendsPaidAsOf(fl.series, t, addDays(t, -(DIVIDEND_WINDOW_DAYS - 1)));
    const sum = divs.reduce((a, d) => a + d.cashDividendPerShare, 0);
    if (sum > 0 && sk.rawClose[i] > 0) rec.dy = sum / sk.rawClose[i];
    return rec;
  }
  function recsAt(t: string): { u1: Rec[]; u2: Rec[] } {
    const hit = recCache.get(t);
    if (hit) return hit;
    const u1: Rec[] = [], tvOk: { sk: Sk; i: number }[] = [];
    for (const sk of stocks) {
      const i = sk.idx.get(t);
      if (i === undefined || i < 1 || !(sk.avgTv[i] >= PIT_MIN_AVG_TRADING_VALUE_WON) || !Number.isFinite(sk.mcap[i - 1])) continue;
      tvOk.push({ sk, i });
      if (sk.mcap[i - 1] >= CAP_EOK) u1.push(evalRec(sk, i, t));
    }
    tvOk.sort((a, b) => b.sk.mcap[b.i - 1] - a.sk.mcap[a.i - 1] || byCode(a.sk, b.sk));
    const u1Map = new Map(u1.map((r) => [r.sk.code, r]));
    const u2 = tvOk.slice(0, U2_TOP_N).map((x) => u1Map.get(x.sk.code) ?? evalRec(x.sk, x.i, t));
    const v = { u1, u2 };
    recCache.set(t, v);
    return v;
  }
  const ew = (recs: Rec[]): Tgt[] => recs.slice(0, N_HOLD).map((r) => ({ code: r.sk.code, w: 1 / N_HOLD }));
  function rankBy(recs: Rec[], key: (r: Rec) => number, desc: boolean): Rec[] {
    return recs.filter((r) => Number.isFinite(key(r))).sort((a, b) => (desc ? key(b) - key(a) : key(a) - key(b)) || byCode(a.sk, b.sk));
  }
  function composite(pool: Rec[]): Rec[] {
    const c = pool.filter((r) => Number.isFinite(r.per) && Number.isFinite(r.pbr) && Number.isFinite(r.roe) && Number.isFinite(r.growth));
    const score = new Map<string, number>();
    for (const [key, desc] of [[(r: Rec) => r.per, false], [(r: Rec) => r.pbr, false], [(r: Rec) => r.roe, true], [(r: Rec) => r.growth, true]] as [(r: Rec) => number, boolean][]) {
      rankBy(c, key, desc).forEach((r, k) => score.set(r.sk.code, (score.get(r.sk.code) ?? 0) + k + 1));
    }
    return [...c].sort((a, b) => score.get(a.sk.code)! - score.get(b.sk.code)! || byCode(a.sk, b.sk));
  }
  function candidates(f: Fid, t: string): Rec[] {
    const { u1, u2 } = recsAt(t);
    switch (f) {
      case "F1": return rankBy(u1, (r) => r.per, false);
      case "F2": return rankBy(u1, (r) => r.pbr, false);
      case "F3": return rankBy(u1, (r) => r.roe, true);
      case "F4": return rankBy(u1, (r) => r.growth, true);
      case "F5": return rankBy(u1, (r) => r.dy, true);
      case "F6": return composite(u1);
      case "F7": return rankBy(u1, (r) => r.peg, false);
      case "F6L": return composite(u2);
    }
  }
  const sims = new Map<Fid, SimOut>();
  for (const f of FIDS) sims.set(f, simulate((t) => ew(candidates(f, t)), stocks, CAL, EVAL_START));

  // ---- 기준선 ----
  const baseSims = new Map<Base, SimOut>();
  const baseTargets: Record<Base, (t: string) => Tgt[]> = {
    D1: (t) => { const s = recsAt(t).u1.slice().sort((a, b) => b.sk.mcap[b.i] - a.sk.mcap[a.i] || byCode(a.sk, b.sk)); return ew(s); },
    D2: (t) => { const s = recsAt(t).u1.slice().sort((a, b) => b.sk.mcap[b.i] - a.sk.mcap[a.i] || byCode(a.sk, b.sk)).slice(0, N_HOLD); const tot = s.reduce((a, r) => a + r.sk.mcap[r.i], 0); return s.map((r) => ({ code: r.sk.code, w: r.sk.mcap[r.i] / tot })); },
    D4: (t) => { const s = recsAt(t).u1; const tot = s.reduce((a, r) => a + r.sk.mcap[r.i], 0); return s.map((r) => ({ code: r.sk.code, w: r.sk.mcap[r.i] / tot })); },
  };
  for (const b of ["D1", "D2", "D4"] as Base[]) baseSims.set(b, simulate(baseTargets[b], stocks, CAL, EVAL_START));
  const kp = kospi.filter((p) => p.tradeDate >= PERIOD_START);
  const kDatesAll = kp.slice(1).map((p) => p.tradeDate);
  const kRetsAll = computeIndexDailyReturnsPct(kp as never);
  const uRets = simulateUniverseMonthlyRebalance(
    pricesByStock, calEval, EVAL_START,
    (code, date) => (liquidity.get(code)?.get(date) ?? NaN) >= PIT_MIN_AVG_TRADING_VALUE_WON, true
  );
  const v3Book = windowBook(v3Trades, EVAL_START);
  const v3Daily = bookDaily(v3Book), pegDaily = bookDaily(pegBook2017);

  // ---- 참고 점검 (2010 창, 게이트 아님) ----
  const v3Full = windowBook(v3Trades, PERIOD_START), pegFull = windowBook(pegTrades2010, PERIOD_START);
  const rv = seriesMetrics(CAL, bookDaily(v3Full), PERIOD_START, TODAY), rp = seriesMetrics(CAL, bookDaily(pegFull), PERIOD_START, TODAY);
  console.log(`\n=== 참고 점검(게이트 아님): 2010 창 재현 ===`);
  console.log(`v3: CAGR ${f2(rv.cagr)} / MDD ${f2(rv.mdd)} / ${v3Full.trades.length}건 (기대 ${REF.v3})`);
  console.log(`peg_lynch: CAGR ${f2(rp.cagr)} / MDD ${f2(rp.mdd)} / ${pegFull.trades.length}건 (기대 ${REF.peg})`);
  console.log(`읽은 행 수: 재무 조회 종목 ${fundBy.size}개(실패 ${fundFail}), stock_annual_fundamentals ${annualRows}행, stock_dividend_history ${dividendRows}행, beta_price_history(KOSPI) ${kospi.length}행`);

  // ---- 1) 데이터 가용성 ----
  console.log(`\n=== 1) 데이터 가용성 (월말 리밸런싱 ${sims.get("F1")!.turn.length}회, 연도별 평균 계산 가능 종목 수) ===`);
  const years: number[] = [];
  for (let y = 2017; y <= Number(TODAY.slice(0, 4)); y++) years.push(y);
  const rebalDates = sims.get("F1")!.turn.map((x) => x.d);
  console.log("| 연도 | U1 종목 | F1 PER | F2 PBR | F3 ROE | F4 성장률 | F5 배당 | F6 합성 | F7 PEG | U2 종목 | F6L 합성 |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|");
  const unfilled: Record<string, number> = {};
  for (const f of FIDS) unfilled[f] = 0;
  for (const d of rebalDates) for (const f of FIDS) if (candidates(f, d).length < N_HOLD) unfilled[f]++;
  for (const y of years) {
    const ds = rebalDates.filter((d) => d.startsWith(`${y}-`));
    if (!ds.length) continue;
    const av = (fn: (d: string) => number): string => mean(ds.map(fn)).toFixed(1);
    console.log(`| ${y} | ${av((d) => recsAt(d).u1.length)} | ${av((d) => candidates("F1", d).length)} | ${av((d) => candidates("F2", d).length)} | ${av((d) => candidates("F3", d).length)} | ${av((d) => candidates("F4", d).length)} | ${av((d) => candidates("F5", d).length)} | ${av((d) => candidates("F6", d).length)} | ${av((d) => candidates("F7", d).length)} | ${av((d) => recsAt(d).u2.length)} | ${av((d) => candidates("F6L", d).length)} |`);
  }
  console.log(`20종목을 못 채운 달 수(전체 ${rebalDates.length}개월): ${FIDS.map((f) => `${f} ${unfilled[f]}`).join(" | ")}`);

  // ---- 2) / 3) 지표 ----
  const rowsAll: [string, SimOut | null, { dates: string[]; rets: number[] } | null, Book | null][] = [
    ...FIDS.map((f): [string, SimOut, null, null] => [FNAME[f], sims.get(f)!, null, null]),
    ...(["D1", "D2", "D4"] as Base[]).map((b): [string, SimOut, null, null] => [BNAME[b], baseSims.get(b)!, null, null]),
    ["유니버스 동일가중 월리밸", null, { dates: calEval, rets: uRets }, null],
    ["KOSPI(가격지수)", null, { dates: kDatesAll, rets: kRetsAll }, null],
    ["상한 없는 v3(2017-04~ 진입분)", null, { dates: CAL, rets: v3Daily }, v3Book],
    ["peg_lynch(창 시작 2017-04-01)", null, { dates: CAL, rets: pegDaily }, pegBook2017],
  ];
  console.log(`\n=== 2) 지표 (전략은 첫 리밸런싱 ${rebalDates[0]} 전까지 현금) ===`);
  for (const [lab, s, e] of SLICES) {
    console.log(`\n[${lab}]`);
    console.log("| 구성 | CAGR % | MDD % | 연환산 회전율 % | 평균 보유 종목 | 평균 현금 % | 거래 수 |");
    console.log("|---|---|---|---|---|---|---|");
    for (const [name, sim, ser, book] of rowsAll) {
      if (sim) {
        const x = sliceStats(sim, s, e);
        console.log(`| ${name} | ${f2(x.cagr)} | ${f2(x.mdd)} | ${f2(x.turnover)} | ${x.hold.toFixed(1)} | ${f2(x.cash)} | ${x.trades} |`);
      } else {
        const m = seriesMetrics(ser!.dates, ser!.rets, s, e);
        let hold = "-", trades = "-";
        if (book) {
          const days = CAL.filter((d) => d >= s && d <= e);
          hold = (days.reduce((a, d) => a + (book.cnt.get(d) ?? 0), 0) / Math.max(days.length, 1)).toFixed(1);
          trades = String(book.trades.filter((t) => t.buyDate >= s && t.buyDate <= e).length);
        }
        console.log(`| ${name} | ${f2(m.cagr)} | ${f2(m.mdd)} | - | ${hold} | - | ${trades} |`);
      }
    }
  }
  console.log(`\n=== 연도별 수익률 % ===`);
  console.log("| 구성 | " + years.join(" | ") + " |");
  console.log("|---|" + years.map(() => "---").join("|") + "|");
  for (const [name, sim, ser] of rowsAll) {
    const d = sim ? sim.dates : ser!.dates, r = sim ? sim.ret : ser!.rets;
    console.log(`| ${name} | ${years.map((y) => f2(seriesYear(d, r, y))).join(" | ")} |`);
  }

  // ---- 사전 통과 기준 ----
  const get = (sim: SimOut, s: string, e: string) => sliceStats(sim, s, e);
  const kFull = seriesMetrics(kDatesAll, kRetsAll, EVAL_START, TODAY);
  const d4 = baseSims.get("D4")!;
  const d4Full = get(d4, EVAL_START, TODAY), d4Learn = get(d4, EVAL_START, LEARN_END), d4Conf = get(d4, CONFIRM_START, TODAY);
  console.log(`\n=== 사전 통과 기준 (같은 기간 KOSPI ${f2(kFull.cagr)}/${f2(kFull.mdd)}, D4 ${f2(d4Full.cagr)}/${f2(d4Full.mdd)}; 학습 D4 ${f2(d4Learn.cagr)}, 확인 D4 ${f2(d4Conf.cagr)}) ===`);
  console.log("| 전략 | 전체 CAGR | C1 | 전체 MDD | C2 | 학습 CAGR | 확인 CAGR | C3 | 통과 |");
  console.log("|---|---|---|---|---|---|---|---|---|");
  let i1 = 0, i2 = 0;
  const passers: { f: Fid; learn: number }[] = [];
  const ox = (b: boolean): string => (b ? "O" : "X");
  for (const f of FIDS) {
    const sim = sims.get(f)!;
    const full = get(sim, EVAL_START, TODAY), learn = get(sim, EVAL_START, LEARN_END), conf = get(sim, CONFIRM_START, TODAY);
    const c1 = full.cagr >= Math.max(kFull.cagr, d4Full.cagr), c2 = full.mdd <= kFull.mdd, c3 = learn.cagr >= d4Learn.cagr && conf.cagr >= d4Conf.cagr;
    if (c3) i1++;
    if (c2) i2++;
    if (c1 && c2 && c3) passers.push({ f, learn: learn.cagr });
    console.log(`| ${FNAME[f]} | ${f2(full.cagr)} | ${ox(c1)} | ${f2(full.mdd)} | ${ox(c2)} | ${f2(learn.cagr)} | ${f2(conf.cagr)} | ${ox(c3)} | ${ox(c1 && c2 && c3)} |`);
  }
  passers.sort((a, b) => b.learn - a.learn);
  console.log(`통과 전략: ${passers.length ? passers.map((p) => FNAME[p.f]).join(", ") : "없음"}`);
  if (passers.length >= 2) console.log(`후보 규칙(학습 CAGR 큰 쪽) 적용: ${FNAME[passers[0].f]}`);
  console.log(`\n=== 정보가치 기준 ===`);
  console.log("| 기준 | 값 |");
  console.log("|---|---|");
  console.log(`| I1 (8개 중 C3 만족 전략 수) | ${i1} |`);
  console.log(`| I2 (8개 중 C2 만족 전략 수) | ${i2} |`);
  console.log(`\n누적 시도 횟수: ${PRIOR_ATTEMPTS} + ${FIDS.length} = ${PRIOR_ATTEMPTS + FIDS.length}회`);
  console.log("완료");
  return {
    calEval, cal: CAL, sims, baseSims, kDates: kDatesAll, kRets: kRetsAll, v3Daily, pegDaily, pegTrades: pegBook2017.trades, pegCnt: pegBook2017.cnt,
    fundRows: { stocks: fundBy.size, annual: annualRows, dividend: dividendRows, kospi: kospi.length },
  };
}

async function main(): Promise<void> {
  console.log(`재무 요인 순위 전략 8종 연구 시작(읽기 전용): ${new Date().toISOString()}`);
  const adjustments = await loadAppliedAdjustments();
  console.log(`조정계수 적용 대상: ${adjustments.size}종목`);
  const series = await loadAllStockSeriesFromParquet(2010, new Date().getUTCFullYear()); // 원본(조정 전)
  console.log(`종목 ${series.size}개 로드, heap ${(process.memoryUsage().heapUsed / 1048576).toFixed(0)}MB`);
  const kospi = await getIndexPriceSeries("KOSPI", PERIOD_START, TODAY);
  const loadFund: StudyInput["loadFund"] = async (code, lsFn) => {
    const r = await loadFundamentalsSeriesWithListedShares(code, lsFn);
    return { series: r.series, ls: r.listedSharesByFiscalYear };
  };
  await runStudy({ series, adjustments, kospi, loadFund });
}
if (process.argv[1] && process.argv[1].endsWith("research-factor-strategies.ts")) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
