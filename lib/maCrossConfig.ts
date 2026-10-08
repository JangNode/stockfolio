import type { MaCrossParams, StrategyRule } from "@/lib/backtest";

/**
 * 이평선 골든/데드크로스(ma_cross) 현행 규칙: 단기 50일 / 장기 200일 (2026-10-08 "v2" 확정).
 * 2016~ 시총 5천억 PIT·비용 반영 백테스트에서 기존 5/20(CAGR -3.0%)보다 6.5%로 나아 교체했다. 새 전략 키를 만들지 않고
 * 기존 ma_cross 키의 규칙을 덮어쓴다 — strategies 테이블에 남아 있는 rule_params(5/20)는 무시한다.
 */
export const MA_CROSS_V2_PARAMS: MaCrossParams = { short_period: 50, long_period: 200 };

export const MA_CROSS_V2_LABEL = "이평선 골든/데드크로스 v2 (50/200)";

/**
 * 새 규칙으로 저장하는 신호의 screening_results.signal_details 표식. 이 표식이 없는 ma_cross 신호는 기존 규칙(5/20)으로
 * 만들어진 이력이다 — 기존 행은 수정하지 않고, 표식 유무로만 구분한다.
 */
export const MA_CROSS_V2_SIGNAL_DETAILS = {
  rule_version: "v2",
  short_period: MA_CROSS_V2_PARAMS.short_period,
  long_period: MA_CROSS_V2_PARAMS.long_period,
} as const;

export function isMaCrossV2Signal(signalDetails: unknown): boolean {
  return (
    typeof signalDetails === "object" &&
    signalDetails !== null &&
    (signalDetails as { rule_version?: unknown }).rule_version === "v2"
  );
}

/** DB에서 읽은 전략 행에 현행 ma_cross 규칙을 적용한다(다른 전략은 그대로). */
export function applyMaCrossV2<T extends StrategyRule>(strategy: T): T {
  return strategy.rule_type === "ma_cross" ? { ...strategy, rule_params: { ...MA_CROSS_V2_PARAMS } } : strategy;
}

// 화면 백테스트가 윈도우 기간 + 장기 이평선 워밍업만큼의 일봉을 받도록 요청 건수를 계산한다(월 ≈ 21거래일 + 여유).
const TRADING_DAYS_PER_MONTH_APPROX = 21;
const HISTORY_BUFFER_ROWS = 20;
export function maCrossBacktestMinRows(months: number): number {
  return Math.ceil(months * TRADING_DAYS_PER_MONTH_APPROX) + MA_CROSS_V2_PARAMS.long_period + HISTORY_BUFFER_ROWS;
}
