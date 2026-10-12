import type { DailyPrice, StrategyRuleType } from "@/lib/backtest";
import { MA_CROSS_KR_MIN_MARKET_CAP_EOK } from "@/lib/maCrossConfig";
import { REVERSAL_BREAKOUT_V2_MIN_MARKET_CAP_EOK } from "@/lib/reversalBreakoutConfig";
import { PIT_LIQUIDITY_LOOKBACK_DAYS, PIT_MIN_AVG_TRADING_VALUE_WON } from "@/lib/strategyBacktestSummaryConfig";

/**
 * 한국 스크리닝의 "신호로 닫히는" 추적 규칙과 후보 유니버스 규칙 (2026-10-12 백테스트 정렬).
 * 진입 판정(전환 첫날 + 진입 필터)·청산 판정(상태 거짓)은 lib/backtest.ts의 isEntrySignalAt/isSignalExitAt을 그대로 쓰고,
 * 이 파일은 (1) 어떤 행이 신호 이탈로 닫히는지 표식, (2) 후보 유니버스(시총·거래대금) 판정만 맡는다. 모두 순수 함수다(클라이언트 컴포넌트도 import).
 */

/** signal_details 표식: 이 행은 손절·익절(7%/20%)이 아니라 신호 이탈(데드크로스/조건 이탈)로 닫힌다. 표식이 없는 기존 행은 기존 방식(7%/20%)으로 계속 추적한다. */
export const SIGNAL_EXIT_DETAILS = { exit_rule: "signal" } as const;

/** 신호 이탈로 닫힌 행의 signal_details.exit_reason 값. status는 스키마 제약상 stopped/profited만 쓸 수 있어 수익률 부호로 고르고, 이 값으로 구분한다. */
export const SIGNAL_EXIT_REASON = "signal_exit";

function readDetails(signalDetails: unknown): Record<string, unknown> | null {
  return typeof signalDetails === "object" && signalDetails !== null && !Array.isArray(signalDetails)
    ? (signalDetails as Record<string, unknown>)
    : null;
}

export function usesSignalExit(signalDetails: unknown): boolean {
  return readDetails(signalDetails)?.exit_rule === SIGNAL_EXIT_DETAILS.exit_rule;
}

export function isSignalExitClosed(signalDetails: unknown): boolean {
  return readDetails(signalDetails)?.exit_reason === SIGNAL_EXIT_REASON;
}

export function withSignalExitReason(signalDetails: unknown): Record<string, unknown> {
  return { ...(readDetails(signalDetails) ?? {}), exit_reason: SIGNAL_EXIT_REASON };
}

/** 신호 이탈로 닫을 때의 status. 기존 status 제약(active/stopped/profited/price_unavailable/price_anomaly)을 바꾸지 않고, 비용 반영 수익률이 양수면 profited. */
export function statusForSignalExit(returnPct: number): "profited" | "stopped" {
  return returnPct > 0 ? "profited" : "stopped";
}

/**
 * 봉 index 직전 PIT_LIQUIDITY_LOOKBACK_DAYS개 봉(당일 제외)의 평균 거래대금(원) = 종가×거래량 평균 — lib/pitUniverse.ts
 * computeTrailingAvgTradingValue(백테스트는 KRX 거래대금을 쓰고 없으면 종가×거래량)와 같은 창 정의다. KIS 일봉에는 거래대금 필드가 없어 종가×거래량으로 근사한다.
 * 직전 봉이 lookback개 미만이면 NaN(조건 불충족).
 */
export function computeAvgTradingValueWon(prices: DailyPrice[], index: number, lookback: number = PIT_LIQUIDITY_LOOKBACK_DAYS): number {
  if (index < lookback) return NaN;
  let sum = 0;
  for (let j = index - lookback; j < index; j++) sum += prices[j].close * prices[j].volume;
  return sum / lookback;
}

export interface KrSignalUniverseRule {
  minMarketCapEok: number;
  minAvgTradingValueWon: number;
}

/** 후보 유니버스 규칙이 있는 전략(백테스트가 검증한 범위만 후보로 삼는다). peg_lynch는 후보 풀을 바꾸지 않아 규칙이 없다(undefined). */
export function krSignalUniverseRule(ruleType: StrategyRuleType): KrSignalUniverseRule | undefined {
  if (ruleType === "ma_cross") {
    return { minMarketCapEok: MA_CROSS_KR_MIN_MARKET_CAP_EOK, minAvgTradingValueWon: PIT_MIN_AVG_TRADING_VALUE_WON };
  }
  if (ruleType === "reversal_breakout_v2") {
    return { minMarketCapEok: REVERSAL_BREAKOUT_V2_MIN_MARKET_CAP_EOK, minAvgTradingValueWon: PIT_MIN_AVG_TRADING_VALUE_WON };
  }
  return undefined;
}

/** 시총을 모르거나(null) 거래대금을 계산할 수 없으면(NaN) 후보에서 제외한다. 규칙이 없는 전략은 항상 통과. */
export function passesKrSignalUniverse(ruleType: StrategyRuleType, marketCapEok: number | null, avgTradingValueWon: number): boolean {
  const rule = krSignalUniverseRule(ruleType);
  if (!rule) return true;
  return (marketCapEok ?? 0) >= rule.minMarketCapEok && avgTradingValueWon >= rule.minAvgTradingValueWon;
}
