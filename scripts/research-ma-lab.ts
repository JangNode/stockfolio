/**
 * [임시 연구 하네스 — 병합 금지, 읽기 전용] ma_cross v2(50/200) 강화 연구 공용 모듈.
 * 사전 등록: research/ma-cross-v2-prereg.md. 기준선 R0 = scripts/diagnose-ma-cross-rule-experiments.ts의
 * R0와 같은 데이터·유니버스·비용·집계 함수(진입 = 골든크로스일 종가, 청산 = 데드크로스일 종가).
 */
import { computeSMA } from "@/lib/sma";
import { type BacktestTrade, type DailyPrice } from "@/lib/backtest";
import { computeCostAdjustedReturnPct } from "@/lib/transactionCost";
import { loadAllStockSeriesFromParquet, type StockDailyPriceRow } from "@/lib/stockDailyPricesStorage";
import { computeTrailingAvgTradingValue } from "@/lib/pitUniverse";
import { loadAppliedAdjustments } from "@/lib/stockPriceAdjustmentsStorage";
import { MA_CROSS_V2_PARAMS } from "@/lib/maCrossConfig";
import {
  STRATEGY_BACKTEST_PRICE_FETCH_LOOKBACK_YEARS,
  STOCK_DATA_EARLIEST_YEAR,
  PIT_LIQUIDITY_LOOKBACK_DAYS,
  PIT_MIN_AVG_TRADING_VALUE_WON,
} from "@/lib/strategyBacktestSummaryConfig";
import {
  accumulateStockDailyReturns,
  computeCumulativeAndMdd,
  computeCagrPct,
  type DailyStockReturns,
  type StockContribution,
} from "@/lib/strategyBacktestSummary";

export const CAP_EOK = 5000;
export const PERIOD_START = "2010-01-01";
export const LEARN_END = "2018-12-31";
export const CONFIRM_START = "2019-01-01";
export const TODAY = new Date().toISOString().slice(0, 10);
const CURRENT_YEAR = new Date().getUTCFullYear();
const FETCH_START = Math.max(STOCK_DATA_EARLIEST_YEAR, Number(PERIOD_START.slice(0, 4)) - STRATEGY_BACKTEST_PRICE_FETCH_LOOKBACK_YEARS);

export type Series = Map<string, StockDailyPriceRow[]>;

export async function loadSeries(): Promise<Series> {
  const adjustments = await loadAppliedAdjustments();
  const s = await loadAllStockSeriesFromParquet(FETCH_START, CURRENT_YEAR, adjustments);
  console.log(`종목 ${s.size}개 로드, heap ${(process.memoryUsage().heapUsed / 1048576).toFixed(0)}MB`);
  return s;
}

export interface Ctx {
  code: string;
  rows: StockDailyPriceRow[];
  prices: DailyPrice[];
  closes: number[];
  sShort: (number | undefined)[];
  sLong: (number | undefined)[];
  avgTv: Float64Array;
  goldens: number[];
  deads: number[];
  n: number;
  entryOk: (i: number) => boolean;
}

export function toPrices(rows: StockDailyPriceRow[]): DailyPrice[] {
  return rows.map((r) => ({
    date: r.tradeDate, open: r.openPrice, high: r.highPrice, low: r.lowPrice, close: r.closePrice,
    volume: r.volume, marketCapEok: r.marketCapEok, listedShares: r.listedShares,
  }));
}

export function buildCtx(code: string, rows: StockDailyPriceRow[]): Ctx {
  const prices = toPrices(rows);
  const n = prices.length;
  const closes = prices.map((p) => p.close);
  const { short_period, long_period } = MA_CROSS_V2_PARAMS;
  const sShort = computeSMA(closes, short_period);
  const sLong = computeSMA(closes, long_period);
  const avgTv = computeTrailingAvgTradingValue(rows, PIT_LIQUIDITY_LOOKBACK_DAYS);
  const goldens: number[] = [];
  const deads: number[] = [];
  for (let i = 1; i < n; i++) {
    const ps = sShort[i - 1], pl = sLong[i - 1], cs = sShort[i], cl = sLong[i];
    if (ps === undefined || pl === undefined || cs === undefined || cl === undefined) continue;
    const prev = ps > pl;
    const cur = cs > cl;
    if (!prev && cur && prices[i].date >= PERIOD_START) goldens.push(i);
    else if (prev && !cur && prices[i].date >= PERIOD_START) deads.push(i);
  }
  const entryOk = (i: number): boolean => avgTv[i] >= PIT_MIN_AVG_TRADING_VALUE_WON && rows[i].marketCapEok >= CAP_EOK;
  return { code, rows, prices, closes, sShort, sLong, avgTv, goldens, deads, n, entryOk };
}

export interface Trade extends BacktestTrade {
  code: string;
  gIdx: number; // 골든크로스 인덱스
  eIdx: number; // 진입 인덱스(지연 진입이면 gIdx+N)
  sIdx: number; // 청산 인덱스
  feat?: Record<string, number>;
}

export interface Rule {
  name: string;
  /** 진입일(eIdx) 종가까지의 정보로만 판단하는 필터. false면 그 골든크로스는 건너뜀. */
  entryFilter?: (ctx: Ctx, e: number) => boolean;
  /** 진입가 대비 종가 기준 고정 손절(0.15 = -15%). */
  stopPct?: number;
  /** 골든크로스 후 N거래일 뒤에도 골든 상태일 때만 그날 종가로 진입. */
  delay?: number;
}

export function genTrades(ctx: Ctx, rule: Rule): Trade[] {
  const { prices, n, goldens, deads } = ctx;
  const out: Trade[] = [];
  let nextAllowedIdx = 0;
  const delay = rule.delay ?? 0;
  for (const g of goldens) {
    if (g <= nextAllowedIdx) continue;
    const nextDead = deads.find((d) => d > g) ?? Infinity;
    const e = g + delay;
    if (e >= n) continue;
    if (e >= nextDead) continue; // 지연 기간 안에 데드크로스 -> 진입 없음
    if (!ctx.entryOk(e)) continue;
    if (rule.entryFilter && !rule.entryFilter(ctx, e)) continue;
    let exitIdx = -1;
    for (let i = e + 1; i < n; i++) {
      if (i >= nextDead) { exitIdx = i; break; }
      if (rule.stopPct !== undefined && prices[i].close <= prices[e].close * (1 - rule.stopPct)) { exitIdx = i; break; }
    }
    const forced = exitIdx === -1;
    const sIdx = forced ? n - 1 : exitIdx;
    out.push({
      code: ctx.code, gIdx: g, eIdx: e, sIdx,
      buyDate: prices[e].date, buyPrice: prices[e].close,
      sellDate: prices[sIdx].date, sellPrice: prices[sIdx].close,
      returnPct: computeCostAdjustedReturnPct(prices[e].close, prices[sIdx].close, prices[sIdx].date, "KR"),
      ...(forced ? { isForcedLiquidation: true } : {}),
    });
    nextAllowedIdx = sIdx;
  }
  return out;
}

export interface Acc {
  trades: Trade[];
  dailyReturns: DailyStockReturns;
  contributions: Map<string, StockContribution>;
}
export const newAcc = (): Acc => ({ trades: [], dailyReturns: new Map(), contributions: new Map() });

export function addTrades(acc: Acc, ctx: Ctx, trades: Trade[]): void {
  if (trades.length === 0) return;
  acc.trades.push(...trades);
  accumulateStockDailyReturns(acc.dailyReturns, acc.contributions, ctx.code, ctx.prices, trades, PERIOD_START, "KR", true);
}

export interface SliceMetrics {
  cagr: number; mdd: number; winRate: number; payoff: number; trades: number; avgRet: number;
}

/** 일별 수익률(동일가중 평균)을 [start,end]로 잘라 CAGR·MDD를, 진입일이 구간에 속한 거래로 승률·손익비를 계산. */
export function sliceMetrics(acc: Acc, start: string, end: string): SliceMetrics {
  const dates = [...acc.dailyReturns.keys()].filter((d) => d >= start && d <= end).sort();
  const daily = dates.map((d) => {
    const e = acc.dailyReturns.get(d)!;
    return (e.reduce((s, x) => s + x.returnPct, 0) / e.length) * 100;
  });
  const { totalReturnPct, mddPct } = computeCumulativeAndMdd(daily);
  const endCap = end > TODAY ? TODAY : end;
  const cagr = computeCagrPct(totalReturnPct, start, endCap);
  const t = acc.trades.filter((x) => x.buyDate >= start && x.buyDate <= end);
  const wins = t.filter((x) => x.returnPct > 0);
  const losses = t.filter((x) => x.returnPct <= 0);
  const aw = wins.reduce((s, x) => s + x.returnPct, 0) / Math.max(wins.length, 1);
  const al = losses.reduce((s, x) => s + x.returnPct, 0) / Math.max(losses.length, 1);
  return {
    cagr, mdd: mddPct,
    winRate: t.length ? (wins.length / t.length) * 100 : 0,
    payoff: al !== 0 ? aw / Math.abs(al) : 0,
    trades: t.length,
    avgRet: t.length ? (t.reduce((s, x) => s + x.returnPct, 0) / t.length) * 100 : 0,
  };
}

export const SLICES: [string, string, string][] = [
  ["전체 2010~", PERIOD_START, TODAY],
  ["학습 2010~2018", PERIOD_START, LEARN_END],
  ["확인 2019~", CONFIRM_START, TODAY],
];

export function fmtMetrics(m: SliceMetrics): string {
  return `CAGR ${m.cagr.toFixed(2)}% | MDD ${m.mdd.toFixed(2)}% | 승률 ${m.winRate.toFixed(1)}% | 손익비 ${m.payoff.toFixed(2)} | 거래 ${m.trades} | 평균 ${m.avgRet.toFixed(2)}%`;
}

export function calmar(m: SliceMetrics): number {
  return m.mdd > 0 ? m.cagr / m.mdd : 0;
}

// ---- 지표 ----

export function computeADX(prices: DailyPrice[], period: number): Float64Array {
  const n = prices.length;
  const adx = new Float64Array(n).fill(NaN);
  if (n < period * 2 + 1) return adx;
  const tr = new Float64Array(n);
  const plusDM = new Float64Array(n);
  const minusDM = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const up = prices[i].high - prices[i - 1].high;
    const down = prices[i - 1].low - prices[i].low;
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
    tr[i] = Math.max(prices[i].high - prices[i].low, Math.abs(prices[i].high - prices[i - 1].close), Math.abs(prices[i].low - prices[i - 1].close));
  }
  let trS = 0, pS = 0, mS = 0;
  for (let i = 1; i <= period; i++) { trS += tr[i]; pS += plusDM[i]; mS += minusDM[i]; }
  const dx = new Float64Array(n).fill(NaN);
  for (let i = period; i < n; i++) {
    if (i > period) { trS = trS - trS / period + tr[i]; pS = pS - pS / period + plusDM[i]; mS = mS - mS / period + minusDM[i]; }
    const pDI = trS > 0 ? (100 * pS) / trS : 0;
    const mDI = trS > 0 ? (100 * mS) / trS : 0;
    dx[i] = pDI + mDI > 0 ? (100 * Math.abs(pDI - mDI)) / (pDI + mDI) : 0;
  }
  let sum = 0;
  for (let i = period; i < period * 2; i++) sum += dx[i];
  adx[period * 2 - 1] = sum / period;
  for (let i = period * 2; i < n; i++) adx[i] = (adx[i - 1] * (period - 1) + dx[i]) / period;
  return adx;
}

/** Wilder RSI(period). */
export function computeRSI(closes: number[], period: number): Float64Array {
  const n = closes.length;
  const rsi = new Float64Array(n).fill(NaN);
  if (n <= period) return rsi;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= period; loss /= period;
  rsi[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < n; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    rsi[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return rsi;
}

/** 진입일(i) 종가까지의 정보만 쓰는 종목 단위 피처(시장 피처는 별도). */
export function stockFeatures(ctx: Ctx, adx: Float64Array, rsi: Float64Array, i: number): Record<string, number> {
  const { sLong, sShort, closes, prices, avgTv, rows } = ctx;
  const num = (v: number | undefined): number => (v === undefined ? NaN : v);
  const l = num(sLong[i]), l20 = num(sLong[i - 20]), s = num(sShort[i]), s20 = num(sShort[i - 20]);
  let hi = -Infinity;
  for (let j = Math.max(0, i - 251); j <= i; j++) if (prices[j].high > hi) hi = prices[j].high;
  let vol60 = NaN;
  if (i >= 60) {
    let m = 0;
    const rs: number[] = [];
    for (let j = i - 59; j <= i; j++) { const r = closes[j] / closes[j - 1] - 1; rs.push(r); m += r; }
    m /= rs.length;
    vol60 = Math.sqrt(rs.reduce((a, r) => a + (r - m) ** 2, 0) / (rs.length - 1)) * 100;
  }
  return {
    adx14: adx[i],
    rsi14: rsi[i],
    slope200_20d: l / l20 - 1,
    gap200: closes[i] / l - 1,
    slope50_20d: s / s20 - 1,
    tvChange20: avgTv[i] / avgTv[i - 20] - 1,
    pos52wHigh: closes[i] / hi - 1,
    vol60d: vol60,
    marketCapEok: rows[i].marketCapEok,
  };
}
