import { computeSMA } from "@/lib/sma";
import { computeCostAdjustedReturnPct } from "@/lib/transactionCost";
import type { Market } from "@/lib/market";
import {
  pickFundamentalsAsOf,
  computeValuationFromSeries,
  type FundamentalsSeries,
  type StockDividendPayment,
} from "@/lib/pointInTimeFundamentals";
import {
  selectEpsCagrFiscalYears,
  computeEpsCagrFromResolvedShares,
  computePeg,
  type ListedSharesByFiscalYear,
} from "@/lib/pegRatio";
import { PEG_MAX_RATIO } from "@/lib/pegConfig";
import { computeReversalBreakoutStates } from "@/lib/reversalBreakout";
import { REVERSAL_BREAKOUT_V2_MIN_INVERSE_RATIO } from "@/lib/reversalBreakoutConfig";

// lib/kis.ts(server-only)의 DailyPrice를 import하지 않고 형태만 맞춰 로컬에 둔다.
// /api/stock/[code]/history가 내려주는 JSON 응답과 동일한 모양이다. marketCapEok/
// listedShares는 KIS 일봉엔 없는 값이라 선택 필드다 — lib/stockDailyPricesStorage.ts
// 기반으로 구성한 시리즈(peg_lynch 등)에만 채워진다. 이 파일이 클라이언트
// 컴포넌트(components/Backtest.tsx)에서도 쓰이기 때문에 lib/pointInTimeFundamentals.ts
// (server-only 아님, 순수 함수만)에서만 값을 import한다 — lib/stockFundamentals.ts를
// 직접 import하면 그 파일의 "server-only" 표시 때문에 클라이언트 번들 빌드가 깨진다.
export interface DailyPrice {
  date: string; // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  marketCapEok?: number;
  listedShares?: number;
}

export interface MaCrossParams {
  short_period: number;
  long_period: number;
  // 매매 추적용 손절/익절 비율(0~1). 지정하지 않으면 기본값(7%/20%)을 쓴다.
  stop_loss_pct?: number;
  take_profit_pct?: number;
}

/** 피터린치 PEG전략. 기준값(PEG_MAX_RATIO, lib/pegConfig.ts)을 rule_params가 아니라
 * 상수로 고정한다 — 종목마다 다른 이동평균 기간 같은 개인화 여지가 없는 전략이라,
 * ma_cross처럼 rule_params에 기준값을 담을 이유가 없다. */
export interface PegLynchParams {
  stop_loss_pct?: number;
  take_profit_pct?: number;
}

/** "급등주 찾기"(역배열 반등) 전략. PEG전략과 같은 이유로 기준값(이동평균
 * 기간, 역배열/매집봉/전환 신호 임계값)을 rule_params가 아니라 lib/reversalBreakoutConfig.ts
 * 상수로 고정한다. */
export interface ReversalBreakoutParams {
  stop_loss_pct?: number;
  take_profit_pct?: number;
}

/** rule_type과 rule_params를 항상 짝으로 다루기 위한 판별 유니언. */
export type StrategyRule =
  | { rule_type: "ma_cross"; rule_params: MaCrossParams }
  | { rule_type: "peg_lynch"; rule_params: PegLynchParams }
  // 급등주 찾기(역배열 반등) 현행 버전. 역배열비율 임계값만 REVERSAL_BREAKOUT_V2_MIN_INVERSE_RATIO(0.9)로
  // 강화하고 rule_params 형태는 이전 버전(v1, 2026-10 종료)과 같다. 버전 계보는 lib/strategyVersions.ts.
  | { rule_type: "reversal_breakout_v2"; rule_params: ReversalBreakoutParams };

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

/** asOfDate 기준 최근 완결된 years개 연도(asOf 연도 자체는 아직 안 끝났을 수 있어
 * 제외 — asOfYear-years ~ asOfYear-1) 각각 최소 1회 배당을 지급했는지 확인한다.
 * dividends는 이미 point-in-time으로 필터링된 것(pickDividendsPaidAsOf 결과)을
 * 받는다고 가정한다. 지급 확인된 연도 목록(내림차순)도 함께 반환해 판단 근거 로그에
 * 쓸 수 있게 한다. */
export function evaluateConsecutiveDividendYears(
  dividends: StockDividendPayment[],
  asOfDate: string,
  years: number
): { consecutiveOk: boolean; paidYears: number[] } {
  const asOfYear = Number(asOfDate.slice(0, 4));
  const paidYearSet = new Set(dividends.map((d) => Number(d.payDate.slice(0, 4))));

  const requiredYears: number[] = [];
  for (let y = asOfYear - years; y <= asOfYear - 1; y++) requiredYears.push(y);

  const consecutiveOk = requiredYears.every((y) => paidYearSet.has(y));
  const paidYears = requiredYears.filter((y) => paidYearSet.has(y)).sort((a, b) => b - a);

  return { consecutiveOk, paidYears };
}

/**
 * 피터린치 PEG전략: 매일 재평가되는 상태 조건. 적자기업은 제외하고(당기순이익 > 0),
 * PEG(=PER÷최근 5년 EPS CAGR)가 PEG_MAX_RATIO(lib/pegConfig.ts) 이하면 참. fundamentals/
 * listedSharesByFiscalYear 중 하나라도 없으면(호출부가 안 넘겼으면) 전부 undefined.
 * "그 시점까지 공시된 재무가 아예 없음"/"5년 전 연도 데이터가 없어 성장률 계산
 * 불가"(상장 초기 등)는 undefined(판정 불가), "적자"/"역성장·PER 계산 불가로 PEG를
 * 못 구함"/"PEG가 기준 초과"는 false(조건 미달)로 구분한다 — false/undefined를 섞어
 * 쓰면 detectStateTransitions가 데이터 공백을 매도 신호로 착각하지 않는다.
 */
function computePegLynchStates(
  prices: DailyPrice[],
  fundamentals: FundamentalsSeries | undefined,
  listedSharesByFiscalYear: ListedSharesByFiscalYear | undefined
): (boolean | undefined)[] {
  if (!fundamentals || !listedSharesByFiscalYear) return prices.map(() => undefined);

  return prices.map((p) => {
    if (p.listedShares === undefined) return undefined;

    const fund = pickFundamentalsAsOf(fundamentals, p.date);
    if (!fund) return undefined; // 그 시점까지 공시된 재무 없음(신규상장 직후 등)
    if (fund.netIncomeParent === null) return undefined; // 순이익 데이터 자체가 없음(공백)
    if (fund.netIncomeParent <= 0) return false; // 적자기업 제외

    const { per } = computeValuationFromSeries(p.close, p.listedShares, fund);

    const pair = selectEpsCagrFiscalYears(fundamentals, p.date);
    if (!pair) return undefined; // 5년 전 연도 데이터가 아예 없음(상장 초기 등) — 판정 불가

    const growthPct = computeEpsCagrFromResolvedShares(pair, listedSharesByFiscalYear);
    const peg = computePeg(per, growthPct);
    if (peg === null) return false; // 역성장/PER 계산 불가 등은 조건 미달로 취급

    return peg <= PEG_MAX_RATIO;
  });
}

/**
 * 전략의 판정 방식.
 * - "event": 교차처럼 순간적으로 발생하는 신호. 오늘 막 발생했는지(직전엔 거짓 → 오늘 참)만 인정.
 * - "state": PEG처럼 매일 다시 평가되는 조건. 오늘 조건을 만족하는지만 확인.
 * 새 전략을 추가할 때 여기에 한 줄만 추가하면 matchesToday가 자동으로 맞게 판정한다.
 */
const STRATEGY_KIND: Record<StrategyRuleType, "event" | "state"> = {
  ma_cross: "event",
  peg_lynch: "state",
  reversal_breakout_v2: "state",
};

/**
 * 전략별 판정 함수 디스패치. 새 전략을 추가하려면:
 * 1) computeXStates(prices, params) 작성 — 봉마다 조건을 만족하는지 true/false/undefined(데이터 부족)로.
 * 2) computeXEntryPrice(prices, ...) 작성 — 신호 발생 시 추천 진입가 (params가 필요 없으면 생략 가능).
 * 3) 위 STRATEGY_KIND에 "event" 또는 "state"로 등록.
 * 4) 아래 computeStates와 computeEntryPlan의 switch에 case 추가.
 * 그 외 matchesToday/runBacktest는 전략 종류와 무관하게 그대로 동작한다.
 *
 * fundamentals는 재무 조건이 필요한 전략(peg_lynch)만 쓴다 — 순수 가격 기반 전략은 무시한다.
 * 호출부가 lib/stockFundamentals.ts의 loadFundamentalsSeries로 한 번만 로드해 넘기면,
 * pickFundamentalsAsOf/pickDividendsPaidAsOf로 날짜별 point-in-time 판정을 DB 호출
 * 없이 반복한다. listedSharesByFiscalYear는 EPS CAGR(PEG) 계산이 필요한 경우(peg_lynch)만 쓴다 — 호출부가
 * loadFundamentalsSeriesWithListedShares로 종목당 한 번만 로드해 넘긴다.
 */
function computeStates(
  prices: DailyPrice[],
  rule: StrategyRule,
  fundamentals?: FundamentalsSeries,
  listedSharesByFiscalYear?: ListedSharesByFiscalYear
): (boolean | undefined)[] {
  switch (rule.rule_type) {
    case "ma_cross":
      return computeMaCrossStates(prices, rule.rule_params);
    case "peg_lynch":
      return computePegLynchStates(prices, fundamentals, listedSharesByFiscalYear);
    case "reversal_breakout_v2":
      return computeReversalBreakoutStates(prices, REVERSAL_BREAKOUT_V2_MIN_INVERSE_RATIO);
  }
}

export interface BacktestTrade {
  buyDate: string;
  buyPrice: number;
  sellDate: string;
  sellPrice: number;
  returnPct: number;
  /** 기간 끝까지 매도 신호가 뜨지 않아 마지막 봉 종가로 강제 청산한 거래면 true.
   * 미실현 손익을 실현 손익처럼 취급한 값이라는 뜻이므로, 결과를 보여줄 땐 구분 표시한다. */
  isForcedLiquidation?: boolean;
}

export interface BacktestResult {
  trades: BacktestTrade[];
  totalReturnPct: number;
  tradeCount: number;
  winRate: number;
  mddPct: number;
  forcedLiquidationCount: number;
  insufficientData: boolean;
}

/**
 * 최대 낙폭(MDD, %). buyDate 기준 순서대로 거래를 복리 체결한다고 가정한 자산 곡선에서
 * 고점 대비 최대 하락폭을 구한다. 종목 여러 개의 거래를 합쳐서 넘겨도(전체 종목 풀
 * 백테스트) buyDate로 정렬해 하나의 자산 곡선으로 취급하므로 그대로 재사용할 수 있다.
 */
export function computeMaxDrawdownPct(trades: BacktestTrade[]): number {
  if (trades.length === 0) return 0;

  const sorted = [...trades].sort((a, b) => a.buyDate.localeCompare(b.buyDate));
  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;

  for (const trade of sorted) {
    equity *= 1 + trade.returnPct;
    if (equity > peak) peak = equity;
    const drawdown = (peak - equity) / peak;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }

  return maxDrawdown * 100;
}

export interface TradeAggregate {
  totalReturnPct: number;
  tradeCount: number;
  winRate: number;
  mddPct: number;
  /** trades 중 isForcedLiquidation(기간 끝 강제 청산)인 거래 수. */
  forcedLiquidationCount: number;
}

/**
 * 거래 목록의 요약 통계(전체 수익률/거래 수/승률/MDD)를 계산한다. buyDate 순으로 복리
 * 체결한다고 가정한다. runBacktest(단일 종목)와 전체 종목 풀 백테스트(여러 종목의 거래를
 * 하나로 합쳐 같은 방식으로 집계) 양쪽에서 재사용한다.
 */
export function aggregateTrades(trades: BacktestTrade[]): TradeAggregate {
  const tradeCount = trades.length;
  const wins = trades.filter((t) => t.returnPct > 0).length;
  const winRate = tradeCount > 0 ? wins / tradeCount : 0;
  const sorted = [...trades].sort((a, b) => a.buyDate.localeCompare(b.buyDate));
  const totalReturnPct = (sorted.reduce((acc, t) => acc * (1 + t.returnPct), 1) - 1) * 100;
  const mddPct = computeMaxDrawdownPct(trades);
  const forcedLiquidationCount = trades.filter((t) => t.isForcedLiquidation).length;

  return { totalReturnPct, tradeCount, winRate, mddPct, forcedLiquidationCount };
}

/**
 * 조건을 만족하기 시작하는 시점마다 매수, 더 이상 만족하지 않게 되는 시점마다 매도하는
 * 단일 포지션 시뮬레이션. ma_cross는 골든/데드크로스, 상태 조건 전략(peg_lynch 등)은
 * 조건을 만족/이탈하는 시점이 각각 매수/매도 신호가 된다. 이평선 등은 prices 전체로
 * 계산해 windowStartDate 시점에 이미 안정된 값을 쓰고, windowStartDate 이후에 발생한
 * 신호만 매매에 반영한다. 기간 끝에 매도 신호 없이 포지션이 열려 있으면(미청산) 마지막
 * 봉 종가로 강제 청산해 통계에 포함시킨다(isForcedLiquidation: true로 표시 — 미실현
 * 손익을 실현 손익처럼 취급했다는 뜻이므로, 결과를 보여줄 땐 이 표시로 구분해야 한다).
 * 완전히 제외하면 정보 손실이 더 크고(표본이 계속 줄고, 어느 방향으로 왜곡됐는지도 알
 * 수 없다), 특히 peg_lynch처럼 상태가 최대 보유기간 없이 몇 년이고 유지될 수 있는
 * 전략에서는 가장 최근 진입한(어쩌면 가장 중요한) 거래가 통째로 사라지는 문제가 있었다.
 */
export function runBacktest(
  prices: DailyPrice[],
  rule: StrategyRule,
  windowStartDate: string,
  fundamentals?: FundamentalsSeries,
  listedSharesByFiscalYear?: ListedSharesByFiscalYear,
  options?: {
    market?: Market;
    includeTransactionCosts?: boolean;
    // 시점별 유니버스용: false를 돌려주는 날의 골든(진입) 신호는 무시한다(보유 중 청산은 영향 없음).
    entryAllowed?: (date: string) => boolean;
  }
): BacktestResult {
  const market = options?.market ?? "KR";
  const includeTransactionCosts = options?.includeTransactionCosts ?? true;
  const states = computeStates(prices, rule, fundamentals, listedSharesByFiscalYear);

  if (states.every((s) => s === undefined)) {
    return {
      trades: [],
      totalReturnPct: 0,
      tradeCount: 0,
      winRate: 0,
      mddPct: 0,
      forcedLiquidationCount: 0,
      insufficientData: true,
    };
  }

  const signals = detectStateTransitions(prices, states).filter((s) => s.date >= windowStartDate);

  const trades: BacktestTrade[] = [];
  let openBuy: { date: string; price: number } | null = null;

  for (const signal of signals) {
    if (signal.type === "golden" && !openBuy && (options?.entryAllowed?.(signal.date) ?? true)) {
      openBuy = { date: signal.date, price: signal.price };
    } else if (signal.type === "dead" && openBuy) {
      const returnPct = includeTransactionCosts
        ? computeCostAdjustedReturnPct(openBuy.price, signal.price, signal.date, market)
        : (signal.price - openBuy.price) / openBuy.price;
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

  if (openBuy) {
    const lastBar = prices[prices.length - 1];
    const returnPct = includeTransactionCosts
      ? computeCostAdjustedReturnPct(openBuy.price, lastBar.close, lastBar.date, market)
      : (lastBar.close - openBuy.price) / openBuy.price;
    trades.push({
      buyDate: openBuy.date,
      buyPrice: openBuy.price,
      sellDate: lastBar.date,
      sellPrice: lastBar.close,
      returnPct,
      isForcedLiquidation: true,
    });
  }

  return { trades, ...aggregateTrades(trades), insufficientData: false };
}

/**
 * 스크리닝용: 가장 최근 봉이 전략 조건을 만족하는지 확인한다.
 * ma_cross는 "방금 골든크로스가 발생"(직전 봉엔 거짓, 이번 봉에 참)했는지만 인정하고,
 * peg_lynch/reversal_breakout_v2는 매일 재평가되는 상태 조건이므로 이번 봉에 참이면 인정한다.
 */
export function matchesToday(
  prices: DailyPrice[],
  rule: StrategyRule,
  fundamentals?: FundamentalsSeries,
  listedSharesByFiscalYear?: ListedSharesByFiscalYear
): boolean {
  const states = computeStates(prices, rule, fundamentals, listedSharesByFiscalYear);
  const lastState = states[states.length - 1];
  if (lastState === undefined || !lastState) return false;

  if (STRATEGY_KIND[rule.rule_type] === "state") {
    return true;
  }

  const prevState = states[states.length - 2];
  return prevState === false;
}

// scripts/replay-reversal-breakout-closed-results.ts와
// supabase/migrations/20260907000000_fix_reversal_breakout_live_tracking_entry_price.sql이
// rule_params에 손절/익절 비율이 없는 기존 행을 보정할 때 이 값과 정확히 같은 기본값을
// 하드코딩해서 쓴다(마이그레이션은 SQL이라 이 파일을 import할 수 없다) — 이 값을 바꾸면
// 그 두 파일도 함께 확인해야 한다.
export const DEFAULT_STOP_LOSS_PCT = 0.07;
export const DEFAULT_TAKE_PROFIT_PCT = 0.2;

export interface EntryPlan {
  entryPrice: number;
  stopLossPrice: number;
  takeProfitPrice: number;
}

/**
 * ma_cross: 교차 자체가 매수 신호인 이벤트라 "돌파를 기다릴 별도 고점"이 없다. 신호가
 * 발생한 당일 종가(=신호가)를 그대로 진입가로 쓴다. 최근 고점을 쓰면 눌림목 회복 중
 * 교차가 발생했을 때 진입가가 신호가보다 높게 잡혀 "신호는 떴는데 아직 진입가엔
 * 도달 못했다"는 모순이 생긴다.
 */
function computeMaCrossEntryPrice(prices: DailyPrice[]): number {
  return prices[prices.length - 1].close;
}

/** peg_lynch: 가치·성장주 전략이라 돌파 개념이 안 맞는다(추세추종이 아니라 "저평가
 * 상태"를 사는 전략). ma_cross처럼 신호 당일 종가를 그대로 진입가로 쓴다. */
function computePegLynchEntryPrice(prices: DailyPrice[]): number {
  return prices[prices.length - 1].close;
}

/**
 * reversal_breakout_v2: 신호 조건 자체(MA20 돌파 시점 포함)가 곧 매수 시점이라 별도로
 * 대기할 피봇가가 필요 없다. 신호일 종가를 그대로 진입가로 쓴다(ma_cross/peg_lynch와 같은 이유).
 */
function computeReversalBreakoutEntryPrice(prices: DailyPrice[]): number {
  return prices[prices.length - 1].close;
}

/**
 * 신호가 발생한 시점의 진입/손절/익절가를 계산한다. 손절가/익절가는 rule_params의
 * stop_loss_pct/take_profit_pct(기본 7%/20%)를 진입가 위에 적용한다. 진입가 자체는
 * 전략마다 성격이 달라 computeXEntryPrice로 분리돼 있다 (위 computeStates 디스패치와
 * 동일한 방식 — 새 전략을 추가하면 여기 switch에도 case를 추가한다).
 */
export function computeEntryPlan(prices: DailyPrice[], rule: StrategyRule): EntryPlan {
  const stopLossPct = rule.rule_params.stop_loss_pct ?? DEFAULT_STOP_LOSS_PCT;
  const takeProfitPct = rule.rule_params.take_profit_pct ?? DEFAULT_TAKE_PROFIT_PCT;

  let entryPrice: number;
  switch (rule.rule_type) {
    case "ma_cross":
      entryPrice = computeMaCrossEntryPrice(prices);
      break;
    case "peg_lynch":
      entryPrice = computePegLynchEntryPrice(prices);
      break;
    case "reversal_breakout_v2":
      entryPrice = computeReversalBreakoutEntryPrice(prices);
      break;
  }

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
