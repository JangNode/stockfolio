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

/**
 * KR 스크리닝·모의투자 후보의 시총 하한(억원). 검증(백테스트)이 시총 5천억 PIT 유니버스에서 이뤄졌으므로 그 범위만 후보로 삼는다
 * (2026-10-08 결정). 이 하한으로 하루 평균 신규 신호는 약 5.2건(시총 500억 이상)에서 약 1.3건으로 줄어든다. US는 적용하지 않는다.
 */
export const MA_CROSS_KR_MIN_MARKET_CAP_EOK = 5000;

/**
 * KR ma_cross는 점수 게이트(MIN_SCREENING_SCORE)를 적용하지 않는다. 50/200 골든크로스 당일은 이평선 격차가 거의 0이라 점수 상한이
 * 약 60점이어서 게이트(51점 이상)를 통과하는 신호가 1.4%뿐이고, 게이트를 켜면 검증한 규칙이 아닌 다른 규칙(CAGR -7.7%, 2016~)이 된다.
 * 면제는 KR 스크리닝(scripts/screen-all-stocks.ts)에만 쓴다 — US는 백테스트 검증이 없어 기존 게이트를 유지한다. 다른 전략의 게이트도
 * 그대로다. 점수 자체는 계산해 저장한다.
 */
export function isScoreGateExempt(ruleType: string): boolean {
  return ruleType === "ma_cross";
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
