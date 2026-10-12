import type { DailyPrice, MaCrossParams, StrategyRule } from "@/lib/backtest";

/**
 * 이평선 골든/데드크로스(ma_cross) v3 규칙 (2026-10-12 확정, v2를 덮어씀 — v2/v3 선택 스위치는 없다).
 *  - 신호: 50일 SMA가 200일 SMA를 아래에서 위로 뚫는 골든크로스(v2와 같음) + 진입일 종가가 직전 252거래일 고가의 -18.29% 이내.
 *  - 청산: 데드크로스(50일 < 200일)만. 손절·익절(7%/20%)은 쓰지 않는다. 닫힌 뒤 재등록은 다음 골든크로스에서만.
 * 새 전략 키를 만들지 않고 기존 ma_cross 키의 규칙을 덮어쓴다 — strategies 테이블에 남아 있는 rule_params(5/20)는 무시한다.
 *
 * [in-sample 임시 채택] 52주 고가 근접 필터는 같은 데이터(2010~현재)로 39회 시도한 연구 중에서 고른 것이라 과적합 위험이 있다
 * (research 브랜치 claude/ma-v2-research-rounds, 사전 등록 research/ma-rounds-prereg-R1.md의 후보 R1b). 연구 결과(전체 구간, 비용 반영,
 * 시총 5천억 PIT): CAGR 6.36% / MDD 53.31% / 승률 32.2% / 손익비 4.03 / 2,335건 (필터 없는 v2: 3.54% / 55.84% / 30.3% / 4.16 / 3,949건).
 * 확인 구간(2019~)은 독립 홀드아웃이 아니다. 이후 실거래 데이터로 재검증해야 한다.
 */
export const MA_CROSS_V3_PARAMS: MaCrossParams = { short_period: 50, long_period: 200 };

export const MA_CROSS_V3_LABEL = "이평선 골든/데드크로스 v3 (50/200 + 52주 고가 -18% 이내)";

/**
 * 52주 고가 근접 필터. 진입일(신호 봉) 종가 ÷ 직전 252거래일 고가 - 1 이 이 값보다 클 때만 신호로 인정한다.
 * 고가 창 = 신호 봉을 포함한 최근 252개 봉의 high (봉이 252개 미만이면 있는 만큼 — research R1b/F3 정의와 동일).
 * -0.1829는 연구 진단(2010~2018 학습 구간 R0 거래의 52주 고가 대비 위치 3분위 하단 경계)에서 정했다.
 */
export const MA_CROSS_NEAR_HIGH_LOOKBACK_BARS = 252;
export const MA_CROSS_NEAR_HIGH_MIN_GAP = -0.1829;

/** 신호 봉(index)의 종가가 직전 252거래일 고가에 충분히 가까운지(종가/고가 - 1 > MA_CROSS_NEAR_HIGH_MIN_GAP). */
export function computeNearHighGap(prices: DailyPrice[], index: number): number {
  let high = -Infinity;
  for (let j = Math.max(0, index - (MA_CROSS_NEAR_HIGH_LOOKBACK_BARS - 1)); j <= index; j++) {
    if (prices[j].high > high) high = prices[j].high;
  }
  return prices[index].close / high - 1;
}

export function passesMaCrossNearHighFilter(prices: DailyPrice[], index: number): boolean {
  return computeNearHighGap(prices, index) > MA_CROSS_NEAR_HIGH_MIN_GAP;
}

/**
 * 새 규칙(v3)으로 저장하는 신호의 screening_results.signal_details 표식. exit_rule "signal"은 이 행이 손절·익절이 아니라
 * 신호 이탈(데드크로스)로 닫힌다는 뜻이다(lib/screeningSignalRules.ts의 usesSignalExit).
 */
export const MA_CROSS_V3_SIGNAL_DETAILS = {
  rule_version: "v3",
  short_period: MA_CROSS_V3_PARAMS.short_period,
  long_period: MA_CROSS_V3_PARAMS.long_period,
  near_high_min_gap: MA_CROSS_NEAR_HIGH_MIN_GAP,
  exit_rule: "signal",
} as const;

export function isMaCrossV3Signal(signalDetails: unknown): boolean {
  return (
    typeof signalDetails === "object" &&
    signalDetails !== null &&
    (signalDetails as { rule_version?: unknown }).rule_version === "v3"
  );
}

/**
 * v2(50/200, 52주 필터 없음, 2026-10-08~10-12) 이력 표식. 한국 스크리닝은 v3부터 이 표식을 새로 만들지 않지만, 이미 쌓인 행을 "v2(구)"로
 * 구분 표시하고 계속 추적하는 데 쓴다. 미국 스크리닝(scripts/screen-us-stocks.ts)은 이번 범위 밖이라 여전히 v2 규칙·표식을 쓴다.
 */
export const MA_CROSS_V2_PARAMS: MaCrossParams = { short_period: 50, long_period: 200 };

export const MA_CROSS_V2_LABEL = "이평선 골든/데드크로스 v2 (50/200)";

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

/** 모의투자 매수 후보로 인정하는 ma_cross 신호(v2 또는 v3 표식). 5/20 구 규칙 행은 제외된다. */
export function isMaCrossPaperCandidateSignal(signalDetails: unknown): boolean {
  return isMaCrossV3Signal(signalDetails) || isMaCrossV2Signal(signalDetails);
}

/**
 * KR 스크리닝·모의투자 후보의 시총 하한(억원). 검증(백테스트)이 시총 5천억 PIT 유니버스에서 이뤄졌으므로 그 범위만 후보로 삼는다
 * (2026-10-08 결정). 이 하한으로 하루 평균 신규 신호는 약 5.2건(시총 500억 이상)에서 약 1.3건으로 줄어든다(52주 필터 도입 전 추정). US는 적용하지 않는다.
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

/** DB에서 읽은 전략 행에 v3 ma_cross 규칙(50/200)을 적용한다(다른 전략은 그대로). */
export function applyMaCrossV3<T extends StrategyRule>(strategy: T): T {
  return strategy.rule_type === "ma_cross" ? { ...strategy, rule_params: { ...MA_CROSS_V3_PARAMS } } : strategy;
}

/** 미국 스크리닝용(범위 밖, v2 규칙 유지). 한국 코드는 applyMaCrossV3를 쓴다. */
export function applyMaCrossV2<T extends StrategyRule>(strategy: T): T {
  return strategy.rule_type === "ma_cross" ? { ...strategy, rule_params: { ...MA_CROSS_V2_PARAMS } } : strategy;
}

// 화면 백테스트가 윈도우 기간 + 장기 이평선 워밍업만큼의 일봉을 받도록 요청 건수를 계산한다(월 ≈ 21거래일 + 여유).
const TRADING_DAYS_PER_MONTH_APPROX = 21;
const HISTORY_BUFFER_ROWS = 20;
export function maCrossBacktestMinRows(months: number): number {
  return (
    Math.ceil(months * TRADING_DAYS_PER_MONTH_APPROX) +
    Math.max(MA_CROSS_V3_PARAMS.long_period, MA_CROSS_NEAR_HIGH_LOOKBACK_BARS) +
    HISTORY_BUFFER_ROWS
  );
}
