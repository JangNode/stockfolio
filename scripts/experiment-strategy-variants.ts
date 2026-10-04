/**
 * 디스포저블 실험(DB 쓰기 없음, 프로덕션 규칙 불변): PIT 시총 유니버스에서 ma_cross/minervini 회전율 감소(B)와
 * 급등주(reversal_breakout/v2) 개선 축소판(A) 변형을 학습(2016~2022)/검증(2023~오늘) 구간별로 평가한다.
 * 비용 반영/미반영 둘 다 계산하고 같은 유니버스 월간 리밸런싱 벤치마크를 구간별로 따로 계산한다.
 * 합격 기준은 코드에 사전 고정돼 있다(결과를 보고 바꾸지 않는다).
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadAllStockSeriesFromParquet, type StockDailyPriceRow } from "@/lib/stockDailyPricesStorage";
import { loadAppliedAdjustments } from "@/lib/stockPriceAdjustmentsStorage";
import type { AppliedAdjustment } from "@/lib/priceAdjustment";
import { computeRuleStates, type DailyPrice, type StrategyRule, type MaCrossParams, type MinerviniParams } from "@/lib/backtest";
import { computeTrailingAvgTradingValue, tradingValueWon } from "@/lib/pitUniverse";
import { getIndexPriceSeries } from "@/lib/betaPriceHistoryStorage";
import { computeMonthlyRebalanceDates, simulateUniverseMonthlyRebalance } from "@/lib/benchmarkSummary";
import { computeCagrPct, computeCumulativeAndMdd } from "@/lib/strategyBacktestSummary";
import { computeEffectiveBuyPrice, computeEffectiveSellPrice } from "@/lib/transactionCost";
import {
  FALLBACK_MA_CROSS_PARAMS,
  FALLBACK_MINERVINI_PARAMS,
  PIT_LIQUIDITY_LOOKBACK_DAYS,
  PIT_MIN_AVG_TRADING_VALUE_WON,
  STRATEGY_BACKTEST_WINDOW_START_YEAR,
} from "@/lib/strategyBacktestSummaryConfig";

// ===== 사전 고정 정의(결과를 보고 바꾸지 않는다) =====
const START = `${STRATEGY_BACKTEST_WINDOW_START_YEAR}-01-01`;
const TRAIN = { from: START, to: "2022-12-31", label: "학습 2016~2022" };
const TODAY = new Date().toISOString().slice(0, 10);
const VALID = { from: "2023-01-01", to: TODAY, label: "검증 2023~" };
const MIN_HOLD_BARS = 20; // b1: 최소 보유 20거래일(그 안의 청산 신호는 무시, 이후 첫 '조건 불충족' 봉에서 청산)
const COOLDOWN_BARS = 20; // b2: 청산 신호 후 20거래일은 신규 진입 금지
const MIN_RAW_CLOSE = 2000; // A-b: 그날 실제(원가) 종가 2,000원 이상
const V2_VOLUME_MULTIPLIER = 4.5; // A-e(v2): 매집봉 거래량 배수 임계 현재 3배의 1.5배
const CAP_MAIN_EOK = 5000;
const CAP_ROBUST_EOK = 10000;
const KOSPI_MA_PERIOD = 200;
const TV_SHORT = 5; // b3 진입 확인: 최근 5거래일 평균 거래대금 > 최근 20거래일 평균 거래대금
const TV_LONG = 20;

type Strategy = "ma_cross" | "minervini_trend_template" | "reversal_breakout" | "reversal_breakout_v2";
type StatesKey = "ma" | "mv" | "rb" | "v2" | "v2m";

interface Variant {
  id: string;
  group: "B" | "A";
  strategy: Strategy;
  label: string;
  statesKey: StatesKey;
  minHold: number;
  cooldown: number;
  volExp: boolean;
  market: boolean;
  minRawClose: number;
  capEok: number;
  nextOpen: boolean;
}

const BASE = { minHold: 0, cooldown: 0, volExp: false, market: false, minRawClose: 0, capEok: CAP_MAIN_EOK, nextOpen: false };

function buildVariants(): Variant[] {
  const list: Variant[] = [];
  const addB = (strategy: Strategy, key: StatesKey, short: string): void => {
    const mk = (suffix: string, label: string, over: Partial<Variant>): void => {
      list.push({ id: `${short}:${suffix}`, group: "B", strategy, label, statesKey: key, ...BASE, ...over });
    };
    mk("base", "현재", {});
    mk("b1", "b1 최소보유20", { minHold: MIN_HOLD_BARS });
    mk("b2", "b2 쿨다운20", { cooldown: COOLDOWN_BARS });
    mk("b3", "b3 거래대금증가", { volExp: true });
    mk("b4", "b4 코스피200일선", { market: true });
    mk("b5-12", "b5 b1+b2", { minHold: MIN_HOLD_BARS, cooldown: COOLDOWN_BARS });
    mk("b5-123", "b5 b1+b2+b3", { minHold: MIN_HOLD_BARS, cooldown: COOLDOWN_BARS, volExp: true });
    mk("b5-124", "b5 b1+b2+b4", { minHold: MIN_HOLD_BARS, cooldown: COOLDOWN_BARS, market: true });
  };
  addB("ma_cross", "ma", "ma");
  addB("minervini_trend_template", "mv", "mv");
  const addA = (strategy: Strategy, baseKey: StatesKey, eKey: StatesKey, short: string): void => {
    const mk = (suffix: string, label: string, key: StatesKey, over: Partial<Variant>): void => {
      list.push({ id: `${short}:${suffix}`, group: "A", strategy, label, statesKey: key, ...BASE, ...over });
    };
    mk("base", "현재", baseKey, {});
    mk("Ab", "A-b 종가2,000원↑", baseKey, { minRawClose: MIN_RAW_CLOSE });
    mk("Ad", "A-d 코스피200일선", baseKey, { market: true });
    mk("Ae", short === "rb" ? "A-e 역배열0.9(=v2 규칙)" : "A-e 거래량배수4.5", eKey, {});
    mk("Acomb", "A-조합 b+d+e", eKey, { minRawClose: MIN_RAW_CLOSE, market: true });
  };
  addA("reversal_breakout", "rb", "v2", "rb");
  addA("reversal_breakout_v2", "v2", "v2m", "v2");
  return list;
}

// ===== 데이터 구조 =====
interface StockCtx {
  code: string;
  rows: StockDailyPriceRow[];
  prices: DailyPrice[];
  avgTv: Float64Array;
  tvShort: Float64Array;
  tvLong: Float64Array;
  raw: Float64Array;
}

interface SimTrade {
  eb: number;
  xb: number;
  entryAtOpen: boolean;
  exitAtOpen: boolean;
}

function toDailyPrice(r: StockDailyPriceRow): DailyPrice {
  return { date: r.tradeDate, open: r.openPrice, high: r.highPrice, low: r.lowPrice, close: r.closePrice, volume: r.volume, marketCapEok: r.marketCapEok, listedShares: r.listedShares };
}

function rawCloses(rows: StockDailyPriceRow[], adj: AppliedAdjustment[] | undefined): Float64Array {
  const out = new Float64Array(rows.length);
  let k = adj?.length ?? 0;
  let cum = 1;
  for (let i = rows.length - 1; i >= 0; i--) {
    while (adj && k > 0 && adj[k - 1].eventDate > rows[i].tradeDate) {
      cum *= adj[k - 1].factor;
      k--;
    }
    out[i] = rows[i].closePrice / cum;
  }
  return out;
}

function rollingMeanTv(rows: StockDailyPriceRow[], window: number): Float64Array {
  const out = new Float64Array(rows.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < rows.length; i++) {
    sum += tradingValueWon(rows[i]);
    if (i >= window) sum -= tradingValueWon(rows[i - window]);
    if (i >= window - 1) out[i] = sum / window;
  }
  return out;
}

async function loadActiveRuleParams(ruleType: "ma_cross" | "minervini_trend_template"): Promise<Record<string, unknown> | null> {
  const { data, error } = await supabaseAdmin.from("strategies").select("rule_params").eq("rule_type", ruleType).eq("market", "KR").limit(1).maybeSingle();
  if (error) throw new Error(error.message);
  return (data?.rule_params as Record<string, unknown>) ?? null;
}

// ===== 시뮬레이션 =====
function simulate(ctx: StockCtx, states: (boolean | undefined)[], v: Variant, kospiAbove: Map<string, boolean>): SimTrade[] {
  const n = ctx.rows.length;
  const trades: SimTrade[] = [];
  let openSig = -1;
  let lastExit = -1e9;
  const gate = (i: number): boolean =>
    ctx.avgTv[i] >= PIT_MIN_AVG_TRADING_VALUE_WON &&
    ctx.rows[i].marketCapEok >= v.capEok &&
    (!v.volExp || ctx.tvShort[i] > ctx.tvLong[i]) &&
    (!v.market || kospiAbove.get(ctx.rows[i].tradeDate) === true) &&
    ctx.raw[i] >= v.minRawClose;
  for (let i = 1; i < n; i++) {
    const prev = states[i - 1];
    const cur = states[i];
    if (prev === undefined || cur === undefined) continue;
    if (openSig < 0) {
      if (!prev && cur && ctx.rows[i].tradeDate >= START && i - lastExit > v.cooldown && gate(i)) {
        if (v.nextOpen && i + 1 >= n) continue;
        openSig = i;
      }
    } else if (!cur && i - openSig >= v.minHold) {
      const eb = v.nextOpen ? openSig + 1 : openSig;
      const exitFillable = !v.nextOpen || i + 1 < n;
      trades.push({ eb, xb: v.nextOpen ? (exitFillable ? i + 1 : n - 1) : i, entryAtOpen: v.nextOpen, exitAtOpen: v.nextOpen && exitFillable });
      lastExit = i;
      openSig = -1;
    }
  }
  if (openSig >= 0) {
    const eb = v.nextOpen ? openSig + 1 : openSig;
    trades.push({ eb, xb: n - 1, entryAtOpen: v.nextOpen, exitAtOpen: false });
  }
  return trades;
}

function accumulate(ctx: StockCtx, trades: SimTrade[], calIndex: Map<string, number>, sum: Float64Array, cnt: Int32Array, withCosts: boolean): void {
  const px = ctx.prices;
  const openAt = (k: number): number => (px[k].open > 0 ? px[k].open : px[k].close);
  for (const t of trades) {
    const startK = t.entryAtOpen ? t.eb : t.eb + 1;
    const entryPrice = t.entryAtOpen ? openAt(t.eb) : px[t.eb].close;
    for (let k = startK; k <= t.xb; k++) {
      const ci = calIndex.get(px[k].date);
      if (ci === undefined) continue;
      const startRef = k === t.eb && t.entryAtOpen ? openAt(k) : px[k - 1].close;
      const endRef = k === t.xb && t.exitAtOpen ? openAt(k) : px[k].close;
      let mult = endRef / startRef;
      if (withCosts) {
        if (k === startK) mult /= computeEffectiveBuyPrice(entryPrice) / entryPrice;
        if (k === t.xb) mult *= computeEffectiveSellPrice(endRef, px[k].date, "KR") / endRef;
      }
      sum[ci] += mult - 1;
      cnt[ci]++;
    }
  }
}

interface Period {
  cagrOn: number;
  cagrOff: number;
  mddOn: number;
  trades: number;
  avgHold: number;
}

interface VariantAcc {
  v: Variant;
  sumOn: Float64Array;
  cntOn: Int32Array;
  sumOff: Float64Array;
  cntOff: Int32Array;
  trainTrades: number;
  validTrades: number;
  trainHold: number;
  validHold: number;
}

function sliceMetrics(dates: string[], pct: number[], from: string, to: string): { cagr: number; mdd: number } {
  const sl: number[] = [];
  for (let i = 0; i < dates.length; i++) if (dates[i] >= from && dates[i] <= to) sl.push(pct[i]);
  const { totalReturnPct, mddPct } = computeCumulativeAndMdd(sl);
  return { cagr: computeCagrPct(totalReturnPct, from, to), mdd: mddPct };
}

function seriesFrom(acc: VariantAcc, calendar: string[], costs: boolean): { dates: string[]; pct: number[] } {
  const sum = costs ? acc.sumOn : acc.sumOff;
  const cnt = costs ? acc.cntOn : acc.cntOff;
  const dates: string[] = [];
  const pct: number[] = [];
  for (let i = 0; i < calendar.length; i++) {
    if (cnt[i] > 0) {
      dates.push(calendar[i]);
      pct.push((sum[i] / cnt[i]) * 100);
    }
  }
  return { dates, pct };
}

function periodOf(acc: VariantAcc, calendar: string[], p: { from: string; to: string }, isTrain: boolean): Period {
  const on = seriesFrom(acc, calendar, true);
  const off = seriesFrom(acc, calendar, false);
  const m1 = sliceMetrics(on.dates, on.pct, p.from, p.to);
  const m2 = sliceMetrics(off.dates, off.pct, p.from, p.to);
  const trades = isTrain ? acc.trainTrades : acc.validTrades;
  return { cagrOn: m1.cagr, cagrOff: m2.cagr, mddOn: m1.mdd, trades, avgHold: trades > 0 ? (isTrain ? acc.trainHold : acc.validHold) / trades : 0 };
}

interface BenchPeriods {
  on: { train: { cagr: number; mdd: number }; valid: { cagr: number; mdd: number } };
  off: { train: { cagr: number; mdd: number }; valid: { cagr: number; mdd: number } };
}

async function main(): Promise<void> {
  const startedMs = Date.now();
  const variants0 = buildVariants();
  console.log(
    `[사전 고정 정의] 유니버스: 그날(as-of) 시총 ${CAP_MAIN_EOK}억 이상 + 직전 20거래일 평균 거래대금 5억 이상, 상장폐지 포함, 테마 예외 제외. ` +
      `학습 ${TRAIN.from}~${TRAIN.to} / 검증 ${VALID.from}~. 청산은 현재 전략과 동일하게 '조건 불충족 전환' 신호뿐(손절·익절 없음).\n` +
      `  b1: 최소 보유 ${MIN_HOLD_BARS}거래일(그 안의 청산 신호는 무시하고, 이후 처음 조건이 불충족인 봉에서 종가 청산) / b2: 청산 신호 후 ${COOLDOWN_BARS}거래일 신규 진입 금지 / ` +
      `b3: 진입일 최근 ${TV_SHORT}일 평균 거래대금 > 최근 ${TV_LONG}일 평균 거래대금(진입일 포함) / b4: 진입일 코스피 종가 > 코스피 ${KOSPI_MA_PERIOD}일 이동평균 / ` +
      `b5: b1+b2+(학습 비용반영 CAGR이 현재보다 높은 b3·b4 중 더 높은 하나, 둘 다 못 넘으면 b1+b2만)\n` +
      `  A-b: 그날 원가 종가 ≥ ${MIN_RAW_CLOSE}원 / A-d: 코스피 ${KOSPI_MA_PERIOD}일선 위 / A-e: v1은 역배열 비율 0.7→0.9(=v2 규칙), v2는 매집봉 거래량 배수 3→${V2_VOLUME_MULTIPLIER} / A-조합: A-b+A-d+A-e\n` +
      `  합격(B): 학습·검증 모두 비용반영 CAGR > 같은 구간 벤치마크(비용반영) 그리고 구간별 거래건수 < 현재. 합격(A): 학습·검증 모두 비용반영 CAGR > 0 그리고 비용미반영 CAGR > 같은 구간 벤치마크(비용미반영).\n` +
      `  진입은 신호 봉 종가 체결(기본), 현실화 검증은 합격 후보에만 다음 거래일 시가 체결.`
  );

  const [maActive, mvActive] = await Promise.all([loadActiveRuleParams("ma_cross"), loadActiveRuleParams("minervini_trend_template")]);
  const maParams = (maActive as unknown as MaCrossParams | null) ?? FALLBACK_MA_CROSS_PARAMS;
  const mvParams = (mvActive as unknown as MinerviniParams | null) ?? FALLBACK_MINERVINI_PARAMS;
  const RULES: Record<StatesKey, { rule: StrategyRule; overrides?: { accumulationVolumeMultiplier?: number } }> = {
    ma: { rule: { rule_type: "ma_cross", rule_params: maParams } },
    mv: { rule: { rule_type: "minervini_trend_template", rule_params: mvParams } },
    rb: { rule: { rule_type: "reversal_breakout", rule_params: {} } },
    v2: { rule: { rule_type: "reversal_breakout_v2", rule_params: {} } },
    v2m: { rule: { rule_type: "reversal_breakout_v2", rule_params: {} }, overrides: { accumulationVolumeMultiplier: V2_VOLUME_MULTIPLIER } },
  };

  const kospi = await getIndexPriceSeries("KOSPI", "2014-01-01", TODAY);
  const calendar = kospi.map((p) => p.tradeDate).filter((d) => d >= START).sort();
  const calIndex = new Map(calendar.map((d, i) => [d, i]));
  const kospiAbove = new Map<string, boolean>();
  {
    let sum = 0;
    for (let i = 0; i < kospi.length; i++) {
      sum += kospi[i].closePrice;
      if (i >= KOSPI_MA_PERIOD) sum -= kospi[i - KOSPI_MA_PERIOD].closePrice;
      if (i >= KOSPI_MA_PERIOD - 1) kospiAbove.set(kospi[i].tradeDate, kospi[i].closePrice > sum / KOSPI_MA_PERIOD);
    }
  }
  const rebalanceDates = computeMonthlyRebalanceDates(calendar);

  const adjustments = await loadAppliedAdjustments();
  const seriesByCode = await loadAllStockSeriesFromParquet(2011, new Date().getUTCFullYear(), adjustments);
  console.log(`전 종목 ${seriesByCode.size}개 로드, ${((Date.now() - startedMs) / 1000).toFixed(0)}초`);

  // 종목별 컨텍스트(최소 시총 기준 5천억·유동성 5억을 한 번이라도 넘긴 종목만 전략 시뮬레이션 대상) + 벤치마크용 자료.
  const pricesByStock = new Map<string, { date: string; close: number }[]>();
  const liquidityByCap = new Map<number, Map<string, Map<string, number>>>([
    [CAP_MAIN_EOK, new Map()],
    [CAP_ROBUST_EOK, new Map()],
  ]);
  const ctxs: StockCtx[] = [];
  for (const [code, rows] of seriesByCode) {
    if (rows.length === 0) continue;
    const avgTv = computeTrailingAvgTradingValue(rows, PIT_LIQUIDITY_LOOKBACK_DAYS);
    const idx = new Map(rows.map((r, i) => [r.tradeDate, i]));
    for (const [cap, store] of liquidityByCap) {
      const m = new Map<string, number>();
      for (const d of rebalanceDates) {
        const i = idx.get(d);
        if (i !== undefined && Number.isFinite(avgTv[i]) && rows[i].marketCapEok >= cap) m.set(d, avgTv[i]);
      }
      store.set(code, m);
    }
    pricesByStock.set(code, rows.map((r) => ({ date: r.tradeDate, close: r.closePrice })));
    let ever = false;
    for (let i = 0; i < rows.length && !ever; i++) ever = rows[i].tradeDate >= START && avgTv[i] >= PIT_MIN_AVG_TRADING_VALUE_WON && rows[i].marketCapEok >= CAP_MAIN_EOK;
    if (!ever) continue;
    ctxs.push({
      code,
      rows,
      prices: rows.map(toDailyPrice),
      avgTv,
      tvShort: rollingMeanTv(rows, TV_SHORT),
      tvLong: rollingMeanTv(rows, TV_LONG),
      raw: rawCloses(rows, adjustments.get(code)),
    });
  }
  console.log(`전략 시뮬레이션 대상(5천억·유동성 한 번이라도 충족) ${ctxs.length}종목`);

  // 벤치마크(구간별·시총별·비용별).
  const benchmarkFor = (cap: number): BenchPeriods => {
    const liq = liquidityByCap.get(cap)!;
    const eligible = (code: string, date: string): boolean => (liq.get(code)?.get(date) ?? NaN) >= PIT_MIN_AVG_TRADING_VALUE_WON;
    const run = (costs: boolean): { train: { cagr: number; mdd: number }; valid: { cagr: number; mdd: number } } => {
      const pct = simulateUniverseMonthlyRebalance(pricesByStock, calendar, START, eligible, costs);
      const a = sliceMetrics(calendar, pct, TRAIN.from, TRAIN.to);
      const b = sliceMetrics(calendar, pct, VALID.from, VALID.to);
      return { train: a, valid: b };
    };
    return { on: run(true), off: run(false) };
  };
  const bench = new Map<number, BenchPeriods>([
    [CAP_MAIN_EOK, benchmarkFor(CAP_MAIN_EOK)],
    [CAP_ROBUST_EOK, benchmarkFor(CAP_ROBUST_EOK)],
  ]);
  console.log(`벤치마크 계산 완료 ${((Date.now() - startedMs) / 1000).toFixed(0)}초`);

  const runVariants = (variants: Variant[]): Map<string, VariantAcc> => {
    const accs = new Map<string, VariantAcc>();
    for (const v of variants) {
      accs.set(v.id, { v, sumOn: new Float64Array(calendar.length), cntOn: new Int32Array(calendar.length), sumOff: new Float64Array(calendar.length), cntOff: new Int32Array(calendar.length), trainTrades: 0, validTrades: 0, trainHold: 0, validHold: 0 });
    }
    const keys = Array.from(new Set(variants.map((v) => v.statesKey)));
    for (const ctx of ctxs) {
      const statesByKey = new Map<StatesKey, (boolean | undefined)[]>();
      for (const key of keys) statesByKey.set(key, computeRuleStates(ctx.prices, RULES[key].rule, RULES[key].overrides));
      for (const v of variants) {
        const acc = accs.get(v.id)!;
        const trades = simulate(ctx, statesByKey.get(v.statesKey)!, v, kospiAbove);
        for (const t of trades) {
          const entryDate = ctx.rows[t.eb].tradeDate;
          if (entryDate >= TRAIN.from && entryDate <= TRAIN.to) {
            acc.trainTrades++;
            acc.trainHold += t.xb - t.eb;
          } else if (entryDate >= VALID.from) {
            acc.validTrades++;
            acc.validHold += t.xb - t.eb;
          }
        }
        accumulate(ctx, trades, calIndex, acc.sumOn, acc.cntOn, true);
        accumulate(ctx, trades, calIndex, acc.sumOff, acc.cntOff, false);
      }
    }
    return accs;
  };

  const fmt = (n: number): string => (Number.isFinite(n) ? n.toFixed(1) : "-");
  const line = (a: VariantAcc, tr: Period, va: Period, verdict: string): string =>
    `  ${a.v.id.padEnd(9)} ${a.v.label.padEnd(18)} | 학습 비용반영 ${fmt(tr.cagrOn)} / 미반영 ${fmt(tr.cagrOff)} / MDD ${fmt(tr.mddOn)} / ${tr.trades}건 / 평균보유 ${tr.avgHold.toFixed(0)}일 | ` +
    `검증 비용반영 ${fmt(va.cagrOn)} / 미반영 ${fmt(va.cagrOff)} / MDD ${fmt(va.mddOn)} / ${va.trades}건 / 평균보유 ${va.avgHold.toFixed(0)}일 | ${verdict}`;

  // ===== 1차: 시총 5천억, 종가 체결 =====
  const accs1 = runVariants(variants0);
  console.log(`1차 시뮬레이션 완료 ${((Date.now() - startedMs) / 1000).toFixed(0)}초`);
  const b5000 = bench.get(CAP_MAIN_EOK)!;
  console.log(
    `\n[벤치마크 5천억 월간 리밸런싱] ${TRAIN.label}: 비용반영 ${fmt(b5000.on.train.cagr)}/MDD ${fmt(b5000.on.train.mdd)}, 미반영 ${fmt(b5000.off.train.cagr)} | ` +
      `${VALID.label}: 비용반영 ${fmt(b5000.on.valid.cagr)}/MDD ${fmt(b5000.on.valid.mdd)}, 미반영 ${fmt(b5000.off.valid.cagr)}`
  );
  const b10000 = bench.get(CAP_ROBUST_EOK)!;
  console.log(
    `[벤치마크 1조 월간 리밸런싱] ${TRAIN.label}: 비용반영 ${fmt(b10000.on.train.cagr)}/MDD ${fmt(b10000.on.train.mdd)}, 미반영 ${fmt(b10000.off.train.cagr)} | ` +
      `${VALID.label}: 비용반영 ${fmt(b10000.on.valid.cagr)}/MDD ${fmt(b10000.on.valid.mdd)}, 미반영 ${fmt(b10000.off.valid.cagr)}`
  );

  // 회귀 확인: 현재(base) 변형의 전 기간 비용반영 CAGR/거래건수가 배치 결과(5천억 비용반영)와 같은지.
  for (const id of ["ma:base", "mv:base", "rb:base", "v2:base"]) {
    const a = accs1.get(id)!;
    const s = seriesFrom(a, calendar, true);
    const full = sliceMetrics(s.dates, s.pct, START, TODAY);
    console.log(`  [회귀 확인] ${id} 전 기간 비용반영 CAGR ${fmt(full.cagr)} / MDD ${fmt(full.mdd)} / 거래 ${a.trainTrades + a.validTrades}건 (배치: ma -3.0/58.3/31,948, minervini -2.9/66.8/14,061, rb -25.0/98.8/1,290, v2 -22.9/97.0/675)`);
  }

  const results = new Map<string, { tr: Period; va: Period; pass: boolean; reason: string }>();
  const evaluate = (a: VariantAcc, baseAcc: VariantAcc, benchP: BenchPeriods): { tr: Period; va: Period; pass: boolean; reason: string } => {
    const tr = periodOf(a, calendar, TRAIN, true);
    const va = periodOf(a, calendar, VALID, false);
    const baseTr = periodOf(baseAcc, calendar, TRAIN, true);
    const baseVa = periodOf(baseAcc, calendar, VALID, false);
    let pass: boolean;
    let reason: string;
    if (a.v.group === "B") {
      const okCagr = tr.cagrOn > benchP.on.train.cagr && va.cagrOn > benchP.on.valid.cagr;
      const okTrades = tr.trades < baseTr.trades && va.trades < baseVa.trades;
      pass = okCagr && okTrades;
      reason = `${okCagr ? "" : "비용반영 CAGR<벤치마크 "}${okTrades ? "" : "거래건수 미감소"}`.trim();
    } else {
      const okCagr = tr.cagrOn > 0 && va.cagrOn > 0;
      const okOff = tr.cagrOff > benchP.off.train.cagr && va.cagrOff > benchP.off.valid.cagr;
      pass = okCagr && okOff;
      reason = `${okCagr ? "" : "비용반영 CAGR≤0 "}${okOff ? "" : "비용미반영<벤치마크"}`.trim();
    }
    return { tr, va, pass, reason };
  };

  // b5 선택(학습 구간 수치만 사용).
  const chosenB5 = new Map<string, string>();
  for (const short of ["ma", "mv"]) {
    const baseTrain = periodOf(accs1.get(`${short}:base`)!, calendar, TRAIN, true).cagrOn;
    const c3 = periodOf(accs1.get(`${short}:b3`)!, calendar, TRAIN, true).cagrOn;
    const c4 = periodOf(accs1.get(`${short}:b4`)!, calendar, TRAIN, true).cagrOn;
    let pick = `${short}:b5-12`;
    if (Math.max(c3, c4) > baseTrain) pick = c3 >= c4 ? `${short}:b5-123` : `${short}:b5-124`;
    chosenB5.set(short, pick);
  }
  console.log(`\n[b5 선택(학습 비용반영 CAGR만 사용)] ma: ${chosenB5.get("ma")}, minervini: ${chosenB5.get("mv")}`);

  console.log("\n===== B. ma_cross / minervini 회전율 감소 (시총 5천억, 종가 체결) =====");
  for (const short of ["ma", "mv"]) {
    for (const a of accs1.values()) {
      if (!a.v.id.startsWith(`${short}:`)) continue;
      const isB5Alt = a.v.id.startsWith(`${short}:b5-`);
      const selected = chosenB5.get(short) === a.v.id;
      const r = evaluate(a, accs1.get(`${short}:base`)!, b5000);
      results.set(a.v.id, r);
      const verdict = a.v.id.endsWith(":base") ? "기준" : isB5Alt && !selected ? `(참고, 미선택) ${r.pass ? "합격" : "불합격"}` : r.pass ? "합격" : `불합격(${r.reason})`;
      console.log(line(a, r.tr, r.va, verdict));
    }
  }
  console.log("\n===== A. 급등주 개선 축소판 (시총 5천억, 종가 체결) =====");
  for (const short of ["rb", "v2"]) {
    for (const a of accs1.values()) {
      if (!a.v.id.startsWith(`${short}:`)) continue;
      const r = evaluate(a, accs1.get(`${short}:base`)!, b5000);
      results.set(a.v.id, r);
      console.log(line(a, r.tr, r.va, a.v.id.endsWith(":base") ? "기준" : r.pass ? "합격" : `불합격(${r.reason})`));
    }
  }

  // ===== 합격 후보: 1조 강건성 + 다음날 시가 체결 =====
  const passers: Variant[] = [];
  for (const a of accs1.values()) {
    const id = a.v.id;
    if (id.endsWith(":base")) continue;
    if (id.includes(":b5-") && !Array.from(chosenB5.values()).includes(id)) continue;
    if (results.get(id)?.pass) passers.push(a.v);
  }
  console.log(`\n합격 후보 ${passers.length}개: ${passers.map((p) => p.id).join(", ") || "없음"}`);
  if (passers.length > 0) {
    const extra: Variant[] = [];
    for (const p of passers) {
      extra.push({ ...p, id: `${p.id}@1조`, capEok: CAP_ROBUST_EOK });
      extra.push({ ...p, id: `${p.id}@다음날시가`, nextOpen: true });
      extra.push({ ...p, id: `${p.id}@1조·다음날시가`, capEok: CAP_ROBUST_EOK, nextOpen: true });
    }
    const bases: Variant[] = [];
    for (const p of passers) {
      const short = p.id.split(":")[0];
      for (const cap of [CAP_ROBUST_EOK]) bases.push({ ...variants0.find((v) => v.id === `${short}:base`)!, id: `${short}:base@1조`, capEok: cap });
    }
    const uniqueBases = Array.from(new Map(bases.map((b) => [b.id, b])).values());
    const accs2 = runVariants([...extra, ...uniqueBases]);
    console.log("\n===== 합격 후보 강건성/현실화 =====");
    for (const e of extra) {
      const a = accs2.get(e.id)!;
      const short = e.id.split(":")[0];
      const baseAcc = e.capEok === CAP_ROBUST_EOK ? accs2.get(`${short}:base@1조`)! : accs1.get(`${short}:base`)!;
      const r = evaluate(a, baseAcc, bench.get(e.capEok)!);
      console.log(line(a, r.tr, r.va, `${e.capEok === CAP_ROBUST_EOK ? "1조 벤치마크 기준 " : ""}${r.pass ? "합격" : `불합격(${r.reason})`}`));
    }
  }
  console.log(`\n실행 시간 ${((Date.now() - startedMs) / 1000).toFixed(0)}초, 최대 메모리(RSS) ${(process.resourceUsage().maxRSS / 1024).toFixed(0)}MB`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
