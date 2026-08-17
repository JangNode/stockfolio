import { computeSMA } from "@/lib/sma";

// lib/kis.ts(server-only)의 DailyPrice를 import하지 않고 형태만 맞춰 로컬에 둔다.
// /api/stock/[code]/history가 내려주는 JSON 응답과 동일한 모양이다.
export interface DailyPrice {
  date: string; // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface MaCrossParams {
  short_period: number;
  long_period: number;
  // 매매 추적용 손절/익절 비율(0~1). 지정하지 않으면 기본값(7%/20%)을 쓴다.
  stop_loss_pct?: number;
  take_profit_pct?: number;
}

export interface MinerviniParams {
  ma_short: number;
  ma_mid: number;
  ma_long: number;
  stop_loss_pct?: number;
  take_profit_pct?: number;
}

/** rule_type과 rule_params를 항상 짝으로 다루기 위한 판별 유니언. */
export type StrategyRule =
  | { rule_type: "ma_cross"; rule_params: MaCrossParams }
  | { rule_type: "minervini_trend_template"; rule_params: MinerviniParams };

export type StrategyRuleType = StrategyRule["rule_type"];

export interface CrossSignal {
  index: number;
  date: string;
  type: "golden" | "dead"; // 조건 진입(golden) / 이탈(dead) — ma_cross 외 전략에도 같은 의미로 재사용
  price: number;
}

/** true/false/undefined(데이터 부족) 상태 배열에서 false→true(golden), true→false(dead) 전환 시점을 찾는다. */
function detectStateTransitions(
  prices: DailyPrice[],
  states: (boolean | undefined)[]
): CrossSignal[] {
  const signals: CrossSignal[] = [];

  for (let i = 1; i < prices.length; i++) {
    const prev = states[i - 1];
    const cur = states[i];
    if (prev === undefined || cur === undefined) continue;

    if (!prev && cur) {
      signals.push({ index: i, date: prices[i].date, type: "golden", price: prices[i].close });
    } else if (prev && !cur) {
      signals.push({ index: i, date: prices[i].date, type: "dead", price: prices[i].close });
    }
  }

  return signals;
}

/**
 * 단기 이평선이 장기 이평선 위에 있는 상태(참)인지 아래에 있는 상태(거짓)인지.
 * 이 상태가 거짓→참으로 바뀌는 순간이 골든크로스, 참→거짓으로 바뀌는 순간이 데드크로스다.
 */
function computeMaCrossStates(
  prices: DailyPrice[],
  params: MaCrossParams
): (boolean | undefined)[] {
  const closes = prices.map((p) => p.close);
  const shortSMA = computeSMA(closes, params.short_period);
  const longSMA = computeSMA(closes, params.long_period);

  return prices.map((_, i) => {
    const s = shortSMA[i];
    const l = longSMA[i];
    if (s === undefined || l === undefined) return undefined;
    return s > l;
  });
}

// 미너비니 원문 그대로 일봉 기준: 52주 신고/신저가 ≈ 250거래일, 장기 이평선 상승 추세
// 확인은 최근 20거래일(약 1개월) 전과 비교한다.
const MINERVINI_HIGH_LOW_WINDOW = 250;
const MINERVINI_TREND_LOOKBACK = 20;

/**
 * 미너비니 트렌드 템플릿(일봉 기준, IBD RS순위 제외 7개 조건). 모두 만족해야 참:
 * 1. 현재가 > 중기·장기 이평선   2. 중기 이평선 > 장기 이평선
 * 3. 장기 이평선이 20거래일 전보다 높음(상승 추세)   4. 단기 이평선 > 중기·장기 이평선
 * 5. 현재가 > 단기 이평선   6. 현재가 ≥ 250거래일 신저가 × 1.3   7. 현재가 ≥ 250거래일 신고가 × 0.75
 */
function computeMinerviniStates(
  prices: DailyPrice[],
  params: MinerviniParams
): (boolean | undefined)[] {
  const { ma_short, ma_mid, ma_long } = params;
  const closes = prices.map((p) => p.close);
  const shortSMA = computeSMA(closes, ma_short);
  const midSMA = computeSMA(closes, ma_mid);
  const longSMA = computeSMA(closes, ma_long);

  // 250거래일 신고/신저가 계산에 필요한 구간과, 장기 이평선의 20거래일 전 값이 존재해야
  // 하는 구간 중 더 늦게 충족되는 인덱스부터 조건 판정이 가능하다.
  const minIndex = Math.max(
    MINERVINI_HIGH_LOW_WINDOW - 1,
    ma_long - 1 + MINERVINI_TREND_LOOKBACK,
    ma_mid - 1,
    ma_short - 1
  );

  return prices.map((_, i) => {
    if (i < minIndex) return undefined;

    const price = closes[i];
    const s = shortSMA[i];
    const m = midSMA[i];
    const l = longSMA[i];
    const lPrev = longSMA[i - MINERVINI_TREND_LOOKBACK];
    if (s === undefined || m === undefined || l === undefined || lPrev === undefined) {
      return undefined;
    }

    let high250 = -Infinity;
    let low250 = Infinity;
    for (let j = i - MINERVINI_HIGH_LOW_WINDOW + 1; j <= i; j++) {
      if (prices[j].high > high250) high250 = prices[j].high;
      if (prices[j].low < low250) low250 = prices[j].low;
    }

    return (
      price > m &&
      price > l &&
      m > l &&
      l > lPrev &&
      s > m &&
      s > l &&
      price > s &&
      price >= low250 * 1.3 &&
      price >= high250 * 0.75
    );
  });
}

function computeStates(prices: DailyPrice[], rule: StrategyRule): (boolean | undefined)[] {
  if (rule.rule_type === "minervini_trend_template") {
    return computeMinerviniStates(prices, rule.rule_params);
  }
  return computeMaCrossStates(prices, rule.rule_params);
}

export interface BacktestTrade {
  buyDate: string;
  buyPrice: number;
  sellDate: string;
  sellPrice: number;
  returnPct: number;
}

export interface BacktestResult {
  trades: BacktestTrade[];
  totalReturnPct: number;
  tradeCount: number;
  winRate: number;
  insufficientData: boolean;
}

/**
 * 조건을 만족하기 시작하는 시점마다 매수, 더 이상 만족하지 않게 되는 시점마다 매도하는
 * 단일 포지션 시뮬레이션. ma_cross는 골든/데드크로스, minervini_trend_template은 7개
 * 조건을 모두 만족/이탈하는 시점이 각각 매수/매도 신호가 된다. 이평선 등은 prices 전체로
 * 계산해 windowStartDate 시점에 이미 안정된 값을 쓰고, windowStartDate 이후에 발생한
 * 신호만 매매에 반영한다. 기간 끝에 매도 신호 없이 포지션이 열려 있으면(미청산) 그
 * 거래는 통계에서 제외한다.
 */
export function runBacktest(
  prices: DailyPrice[],
  rule: StrategyRule,
  windowStartDate: string
): BacktestResult {
  const states = computeStates(prices, rule);

  if (states.every((s) => s === undefined)) {
    return { trades: [], totalReturnPct: 0, tradeCount: 0, winRate: 0, insufficientData: true };
  }

  const signals = detectStateTransitions(prices, states).filter((s) => s.date >= windowStartDate);

  const trades: BacktestTrade[] = [];
  let openBuy: { date: string; price: number } | null = null;

  for (const signal of signals) {
    if (signal.type === "golden" && !openBuy) {
      openBuy = { date: signal.date, price: signal.price };
    } else if (signal.type === "dead" && openBuy) {
      const returnPct = (signal.price - openBuy.price) / openBuy.price;
      trades.push({
        buyDate: openBuy.date,
        buyPrice: openBuy.price,
        sellDate: signal.date,
        sellPrice: signal.price,
        returnPct,
      });
      openBuy = null;
    }
  }

  const tradeCount = trades.length;
  const wins = trades.filter((t) => t.returnPct > 0).length;
  const winRate = tradeCount > 0 ? wins / tradeCount : 0;
  const totalReturnPct =
    (trades.reduce((acc, t) => acc * (1 + t.returnPct), 1) - 1) * 100;

  return { trades, totalReturnPct, tradeCount, winRate, insufficientData: false };
}

/**
 * 스크리닝용: 가장 최근 봉이 전략 조건을 만족하는지 확인한다.
 * ma_cross는 "방금 골든크로스가 발생"(직전 봉엔 거짓, 이번 봉에 참)했는지만 인정하고,
 * minervini_trend_template은 매일 재평가되는 상태 조건이므로 이번 봉에 참이면 인정한다.
 */
export function matchesToday(prices: DailyPrice[], rule: StrategyRule): boolean {
  const states = computeStates(prices, rule);
  const lastState = states[states.length - 1];
  if (lastState === undefined || !lastState) return false;

  if (rule.rule_type === "minervini_trend_template") {
    return true;
  }

  const prevState = states[states.length - 2];
  return prevState === false;
}

// 이제 모든 전략이 일봉을 쓰므로, "최근 4주 고점"은 약 20거래일(주 5거래일 × 4주)로 환산한다.
const ENTRY_BREAKOUT_LOOKBACK_BARS = 20;
const DEFAULT_STOP_LOSS_PCT = 0.07;
const DEFAULT_TAKE_PROFIT_PCT = 0.2;

export interface EntryPlan {
  entryPrice: number;
  stopLossPrice: number;
  takeProfitPrice: number;
}

/**
 * 신호가 발생한 시점의 진입/손절/익절가를 계산한다.
 * 진입 추천가는 최근 4주(≈20거래일)간 고점(돌파가, 미너비니 VCP 피봇 근사)이며, 손절가/익절가는
 * rule_params의 stop_loss_pct/take_profit_pct(기본 7%/20%)를 그 위에 적용한다.
 */
export function computeEntryPlan(prices: DailyPrice[], rule: StrategyRule): EntryPlan {
  const lookback = prices.slice(-ENTRY_BREAKOUT_LOOKBACK_BARS);
  const entryPrice = Math.max(...lookback.map((p) => p.high));
  const stopLossPct = rule.rule_params.stop_loss_pct ?? DEFAULT_STOP_LOSS_PCT;
  const takeProfitPct = rule.rule_params.take_profit_pct ?? DEFAULT_TAKE_PROFIT_PCT;

  return {
    entryPrice,
    stopLossPrice: entryPrice * (1 - stopLossPct),
    takeProfitPrice: entryPrice * (1 + takeProfitPct),
  };
}

export type TrackingStatus = "active" | "stopped" | "profited";

/** 현재가가 손절가 이하면 stopped, 익절가 이상이면 profited, 그 사이면 active. */
export function evaluateTrackingStatus(
  currentPrice: number,
  stopLossPrice: number,
  takeProfitPrice: number
): TrackingStatus {
  if (currentPrice <= stopLossPrice) return "stopped";
  if (currentPrice >= takeProfitPrice) return "profited";
  return "active";
}
