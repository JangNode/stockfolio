/**
 * [임시 실험 스크립트 — 병합 금지] ma_cross v2(50/200) 규칙 변형 실험(전체 기간, in-sample).
 * 운영 코드·DB를 건드리지 않는다(읽기 전용). 메인 배치와 같은 데이터·유니버스·비용·집계 함수를 쓴다.
 * 환경변수: EXP_CAP_EOK(시총 하한, 기본 5000), EXP_START_YEAR(기본 2010), EXP_COMBO(조합 사양, 예 "adx,trail25,vol,cap30").
 */
import { computeSMA } from "@/lib/sma";
import { aggregateTrades, type BacktestTrade, type DailyPrice } from "@/lib/backtest";
import { computeCostAdjustedReturnPct } from "@/lib/transactionCost";
import { loadAllStockSeriesFromParquet, type StockDailyPriceRow } from "@/lib/stockDailyPricesStorage";
import { computeTrailingAvgTradingValue } from "@/lib/pitUniverse";
import { loadAppliedAdjustments } from "@/lib/stockPriceAdjustmentsStorage";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getIndexPriceSeries } from "@/lib/betaPriceHistoryStorage";
import { MA_CROSS_V2_PARAMS } from "@/lib/maCrossConfig";
import {
  STRATEGY_BACKTEST_PRICE_FETCH_LOOKBACK_YEARS,
  STOCK_DATA_EARLIEST_YEAR,
  PIT_LIQUIDITY_LOOKBACK_DAYS,
  PIT_MIN_AVG_TRADING_VALUE_WON,
} from "@/lib/strategyBacktestSummaryConfig";
import {
  accumulateStockDailyReturns,
  computeEqualWeightDailyReturns,
  computeCumulativeAndMdd,
  computeCagrPct,
  type DailyStockReturns,
  type StockContribution,
} from "@/lib/strategyBacktestSummary";

const CAP_EOK = Number(process.env.EXP_CAP_EOK) || 5000;
const START_YEAR = Number(process.env.EXP_START_YEAR) || 2010;
const PERIOD_START = `${START_YEAR}-01-01`;
const TODAY = new Date().toISOString().slice(0, 10);
const CURRENT_YEAR = new Date().getUTCFullYear();
const FETCH_START = Math.max(STOCK_DATA_EARLIEST_YEAR, START_YEAR - STRATEGY_BACKTEST_PRICE_FETCH_LOOKBACK_YEARS);

// 실험 후보 기준값(사용자 지정 — 실험 스크립트 내부 상수).
const ADX_PERIOD = 14; // 표준 Wilder ADX
const ADX_MIN = 20;
const VOLUME_AVG_BARS = 20;

interface Variant {
  name: string;
  adx?: boolean;
  trailPct?: number; // 고점(종가 기준) 대비 하락률(0.25 = -25%)
  exitBelowN?: number; // 종가가 200일선 아래로 N일 연속이면 청산(데드크로스 청산 대체)
  vol?: boolean;
  cap?: number;
}

function parseCombo(spec: string): Variant {
  const v: Variant = { name: `조합(${spec})` };
  for (const part of spec.split(",")) {
    if (part === "adx") v.adx = true;
    else if (part === "vol") v.vol = true;
    else if (part.startsWith("trail")) v.trailPct = Number(part.slice(5)) / 100;
    else if (part.startsWith("exit")) v.exitBelowN = Number(part.slice(4));
    else if (part.startsWith("cap")) v.cap = Number(part.slice(3));
  }
  return v;
}

const VARIANTS: Variant[] = process.env.EXP_R0_ONLY === "true"
  ? [{ name: "R0 (50/200)" }]
  : process.env.EXP_COMBO
  ? [{ name: "R0 (50/200)" }, parseCombo(process.env.EXP_COMBO)]
  : [
      { name: "R0 (50/200)" },
      { name: "1. ADX≥20", adx: true },
      { name: "2a. 트레일링 -20%", trailPct: 0.2 },
      { name: "2b. 트레일링 -25%", trailPct: 0.25 },
      { name: "2c. 트레일링 -30%", trailPct: 0.3 },
      { name: "3a. 200일선 아래 3일 연속 청산", exitBelowN: 3 },
      { name: "3b. 200일선 아래 5일 연속 청산", exitBelowN: 5 },
      { name: "4. 골든크로스일 거래량≥20일평균", vol: true },
      { name: "5a. 동시보유 20종목 상한", cap: 20 },
      { name: "5b. 동시보유 30종목 상한", cap: 30 },
    ];

/** Wilder ADX(period). 앞부분(워밍업)은 NaN. */
function computeADX(prices: DailyPrice[], period: number): Float64Array {
  const n = prices.length;
  const adx = new Float64Array(n).fill(NaN);
  if (n < period * 2 + 1) return adx;
  const tr = new Float64Array(n);
  const plusDM = new Float64Array(n);
  const minusDM = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const upMove = prices[i].high - prices[i - 1].high;
    const downMove = prices[i - 1].low - prices[i].low;
    plusDM[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDM[i] = downMove > upMove && downMove > 0 ? downMove : 0;
    tr[i] = Math.max(
      prices[i].high - prices[i].low,
      Math.abs(prices[i].high - prices[i - 1].close),
      Math.abs(prices[i].low - prices[i - 1].close)
    );
  }
  let trS = 0;
  let pS = 0;
  let mS = 0;
  for (let i = 1; i <= period; i++) {
    trS += tr[i];
    pS += plusDM[i];
    mS += minusDM[i];
  }
  const dx = new Float64Array(n).fill(NaN);
  for (let i = period; i < n; i++) {
    if (i > period) {
      trS = trS - trS / period + tr[i];
      pS = pS - pS / period + plusDM[i];
      mS = mS - mS / period + minusDM[i];
    }
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

interface Acc {
  trades: (BacktestTrade & { code: string })[];
  dailyReturns: DailyStockReturns;
  contributions: Map<string, StockContribution>;
}
const newAcc = (): Acc => ({ trades: [], dailyReturns: new Map(), contributions: new Map() });

async function main(): Promise<void> {
  console.log(`ma_cross 규칙 실험 시작(in-sample, 시총 ${CAP_EOK}억 PIT, ${START_YEAR}~, 비용 반영): ${new Date().toISOString()}`);
  const adjustments = await loadAppliedAdjustments();
  const seriesByCode = await loadAllStockSeriesFromParquet(FETCH_START, CURRENT_YEAR, adjustments);
  console.log(`종목 ${seriesByCode.size}개 로드, heap ${(process.memoryUsage().heapUsed / 1048576).toFixed(0)}MB`);

  // 지수 데이터(beta_price_history) 실제 시작일 확인
  for (const m of ["KOSPI", "KOSDAQ"] as const) {
    const idx = await getIndexPriceSeries(m, "1990-01-01", TODAY);
    console.log(`[지수] ${m}: ${idx.length}행, ${idx[0]?.tradeDate} ~ ${idx[idx.length - 1]?.tradeDate}`);
  }
  let excluded = new Set<string>();
  if (process.env.EXP_EXCLUDE_LOWCONF === "true") {
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabaseAdmin.from("stock_price_adjustment_events").select("stock_code").eq("status", "low_confidence").order("stock_code").range(from, from + 999);
      if (error) throw new Error(error.message);
      for (const r of data ?? []) excluded.add((r as { stock_code: string }).stock_code);
      if (!data || data.length < 1000) break;
    }
    console.log(`low_confidence 이벤트 보유 종목 ${excluded.size}개 전체 제외`);
  }
  const accs = VARIANTS.map(() => newAcc());
  const recentCutoff = new Date(Date.now() - 730 * 86400000).toISOString().slice(0, 10);
  const recentDates = new Set<string>();
  const { short_period, long_period } = MA_CROSS_V2_PARAMS;

  for (const [code, rows] of seriesByCode) {
    if (excluded.has(code)) continue;
    for (const r of rows) if (r.tradeDate >= recentCutoff) recentDates.add(r.tradeDate);
    const prices: DailyPrice[] = rows.map((r: StockDailyPriceRow) => ({
      date: r.tradeDate, open: r.openPrice, high: r.highPrice, low: r.lowPrice, close: r.closePrice,
      volume: r.volume, marketCapEok: r.marketCapEok, listedShares: r.listedShares,
    }));
    const n = prices.length;
    const closes = prices.map((p) => p.close);
    const sShort = computeSMA(closes, short_period);
    const sLong = computeSMA(closes, long_period);
    const avgTv = computeTrailingAvgTradingValue(rows, PIT_LIQUIDITY_LOOKBACK_DAYS);
    const entryOk = (i: number): boolean =>
      avgTv[i] >= PIT_MIN_AVG_TRADING_VALUE_WON && rows[i].marketCapEok >= CAP_EOK;

    // 골든/데드 전환 인덱스(lib/backtest.ts의 computeMaCrossStates + detectStateTransitions와 동일 규칙)
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
    if (goldens.length === 0) continue;
    let anyEligible = false;
    for (const g of goldens) if (entryOk(g)) { anyEligible = true; break; }
    if (!anyEligible) continue;

    const needAdx = VARIANTS.some((v) => v.adx);
    const adx = needAdx ? computeADX(prices, ADX_PERIOD) : null;

    VARIANTS.forEach((v, vi) => {
      const trades: BacktestTrade[] = [];
      let nextAllowedIdx = 0; // 이 인덱스 이후(초과)의 골든만 새 진입 후보
      for (const g of goldens) {
        if (g <= nextAllowedIdx) continue;
        if (!entryOk(g)) continue;
        if (v.adx && !(adx![g] >= ADX_MIN)) continue;
        if (v.vol) {
          if (g < VOLUME_AVG_BARS) continue;
          let s = 0;
          for (let j = g - VOLUME_AVG_BARS; j < g; j++) s += prices[j].volume;
          if (!(prices[g].volume >= s / VOLUME_AVG_BARS)) continue;
        }
        // 청산 탐색
        let exitIdx = -1;
        let peak = prices[g].close;
        let belowRun = 0;
        const nextDead = deads.find((d) => d > g) ?? Infinity;
        for (let i = g + 1; i < n; i++) {
          if (!v.exitBelowN && i >= nextDead) { exitIdx = i; break; } // 데드크로스(기본 청산)
          if (v.trailPct !== undefined) {
            if (prices[i].close > peak) peak = prices[i].close;
            if (prices[i].close <= peak * (1 - v.trailPct)) { exitIdx = i; break; }
          }
          if (v.exitBelowN) {
            const l = sLong[i];
            if (l !== undefined && prices[i].close < l) belowRun++; else belowRun = 0;
            if (belowRun >= v.exitBelowN) { exitIdx = i; break; }
          }
        }
        const forced = exitIdx === -1;
        const sellIdx = forced ? n - 1 : exitIdx;
        trades.push({
          buyDate: prices[g].date,
          buyPrice: prices[g].close,
          sellDate: prices[sellIdx].date,
          sellPrice: prices[sellIdx].close,
          returnPct: computeCostAdjustedReturnPct(prices[g].close, prices[sellIdx].close, prices[sellIdx].date, "KR"),
          ...(forced ? { isForcedLiquidation: true } : {}),
        });
        nextAllowedIdx = sellIdx;
      }
      if (trades.length === 0) return;
      const acc = accs[vi];
      acc.trades.push(...trades.map((t) => ({ ...t, code })));
      if (v.cap === undefined) {
        accumulateStockDailyReturns(acc.dailyReturns, acc.contributions, code, prices, trades, PERIOD_START, "KR", true);
      }
    });
  }

  // 동시보유 상한: 진입일 순으로 처리, 같은 날 후보가 남으면 종목코드 오름차순(중립 규칙)
  VARIANTS.forEach((v, vi) => {
    if (v.cap === undefined) return;
    const acc = accs[vi];
    const sorted = [...acc.trades].sort((a, b) => a.buyDate.localeCompare(b.buyDate) || a.code.localeCompare(b.code));
    const open: string[] = []; // 보유 중 거래의 sellDate
    const accepted: (BacktestTrade & { code: string })[] = [];
    for (const t of sorted) {
      for (let k = open.length - 1; k >= 0; k--) if (open[k] <= t.buyDate) open.splice(k, 1);
      if (open.length >= v.cap) continue;
      open.push(t.sellDate);
      accepted.push(t);
    }
    acc.trades = accepted;
    const byCode = new Map<string, BacktestTrade[]>();
    for (const t of accepted) {
      const list = byCode.get(t.code) ?? [];
      list.push(t);
      byCode.set(t.code, list);
    }
    for (const [code, ts] of byCode) {
      const rows = seriesByCode.get(code)!;
      const prices: DailyPrice[] = rows.map((r) => ({
        date: r.tradeDate, open: r.openPrice, high: r.highPrice, low: r.lowPrice, close: r.closePrice,
        volume: r.volume, marketCapEok: r.marketCapEok, listedShares: r.listedShares,
      }));
      accumulateStockDailyReturns(acc.dailyReturns, acc.contributions, code, prices, ts, PERIOD_START, "KR", true);
    }
  });

  const BUCKETS: [string, string, string][] = [["2010", "2015", "2010~15"], ["2016", "2019", "2016~19"], ["2020", "2022", "2020~22"], ["2023", "2026", "2023~"]];
  console.log("\n=== 결과(in-sample, 비용 반영, 거래당 평균은 진입일 구간 기준) ===");
  VARIANTS.forEach((v, vi) => {
    const acc = accs[vi];
    const t = acc.trades;
    if (t.length === 0) { console.log(`[${v.name}] 거래 없음`); return; }
    const agg = aggregateTrades(t);
    const daily = computeEqualWeightDailyReturns(acc.dailyReturns);
    const { totalReturnPct, mddPct } = computeCumulativeAndMdd(daily);
    const cagr = computeCagrPct(totalReturnPct, PERIOD_START, TODAY);
    const wins = t.filter((x) => x.returnPct > 0);
    const losses = t.filter((x) => x.returnPct <= 0);
    const aw = wins.reduce((s, x) => s + x.returnPct, 0) / Math.max(wins.length, 1) * 100;
    const al = losses.reduce((s, x) => s + x.returnPct, 0) / Math.max(losses.length, 1) * 100;
    const holdDays = t.reduce((s, x) => s + (Date.parse(x.sellDate) - Date.parse(x.buyDate)) / 86400000, 0) / t.length;
    const buckets = BUCKETS.map(([a, b, label]) => {
      const bt = t.filter((x) => x.buyDate.slice(0, 4) >= a && x.buyDate.slice(0, 4) <= b);
      const avg = bt.reduce((s, x) => s + x.returnPct, 0) / Math.max(bt.length, 1) * 100;
      return `${label}: ${bt.length}건 ${avg.toFixed(1)}%`;
    }).join(" | ");
    console.log(
      `[${v.name}] CAGR ${cagr.toFixed(1)}% | MDD ${mddPct.toFixed(1)}% | 거래 ${t.length} | 승률 ${(agg.winRate * 100).toFixed(1)}% | ` +
        `손익비 ${(aw / Math.abs(al || 1)).toFixed(2)} | 평균보유(달력일) ${holdDays.toFixed(0)} | 구간별 거래당평균 ${buckets}`
    );
  });
  const r0t = accs[0].trades.filter((x) => x.buyDate >= recentCutoff);
  console.log(`[신규 신호 빈도] R0 최근 24개월(${recentCutoff}~) 진입 ${r0t.length}건 / 거래일 ${recentDates.size}일 = 하루 평균 ${(r0t.length / Math.max(recentDates.size, 1)).toFixed(2)}건 (시총 ${CAP_EOK}억·유동성 5억 PIT)`);
  console.log("완료");
}

main().catch((e) => { console.error(e); process.exit(1); });
