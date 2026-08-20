import { computeSMA } from "@/lib/sma";
import type { DailyPrice, StrategyRule } from "@/lib/backtest";

// 배점: 조건 충족도(40) + 추세 강도(25) + 거래량 신뢰도(20) + 안정성(15) = 100.
const CONDITION_WEIGHT = 40;
const TREND_WEIGHT = 25;
const VOLUME_WEIGHT = 20;
const STABILITY_WEIGHT = 15;

const VOLUME_LOOKBACK_BARS = 20;
const VOLATILITY_LOOKBACK_BARS = 20;
const TREND_SLOPE_LOOKBACK_BARS = 20;
const HIGH_LOW_WINDOW_BARS = 250;

// 아래 정규화 기준값들은 "이 정도면 여유 있다/불안하다"를 나누는 경험적 기준이라, 실제
// 매칭 분포를 보고 조정할 수 있다. 기준을 넘으면 해당 하위 항목은 만점/0점으로 clamp된다.
const MA_CROSS_GAP_FULL_SCORE_PCT = 3; // 단기·장기 이평선이 3% 이상 벌어지면 조건 충족도 만점
const MINERVINI_MARGIN_FULL_SCORE_PCT = 5; // 현재가가 이평선들보다 평균 5% 이상 높으면 만점
const TREND_SLOPE_FULL_SCORE_PCT = 10; // 장기 이평선이 20거래일 전보다 10% 이상 올랐으면 만점
const VOLATILITY_FULL_PENALTY_PCT = 5; // 최근 일간 변동성 표준편차가 5% 이상이면 안정성 0점

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** 조건 충족도: ma_cross는 골든크로스 직후 단기·장기 이평선 격차, minervini는 현재가와 이평선들 사이 이격도. */
function computeConditionScore(prices: DailyPrice[], rule: StrategyRule): number {
  const closes = prices.map((p) => p.close);
  const i = prices.length - 1;

  if (rule.rule_type === "ma_cross") {
    const { short_period, long_period } = rule.rule_params;
    const shortSMA = computeSMA(closes, short_period)[i];
    const longSMA = computeSMA(closes, long_period)[i];
    if (shortSMA === undefined || longSMA === undefined || longSMA === 0) return 0;

    const gapPct = ((shortSMA - longSMA) / longSMA) * 100;
    return clamp01(gapPct / MA_CROSS_GAP_FULL_SCORE_PCT) * CONDITION_WEIGHT;
  }

  // minervini_trend_template: 현재가가 단/중/장기 이평선을 얼마나 여유 있게 웃도는지 평균 이격도.
  const { ma_short, ma_mid, ma_long } = rule.rule_params;
  const price = closes[i];
  const shortSMA = computeSMA(closes, ma_short)[i];
  const midSMA = computeSMA(closes, ma_mid)[i];
  const longSMA = computeSMA(closes, ma_long)[i];
  if (shortSMA === undefined || midSMA === undefined || longSMA === undefined) return 0;
  if (shortSMA === 0 || midSMA === 0 || longSMA === 0) return 0;

  const avgMarginPct =
    (((price - shortSMA) / shortSMA + (price - midSMA) / midSMA + (price - longSMA) / longSMA) / 3) * 100;
  return clamp01(avgMarginPct / MINERVINI_MARGIN_FULL_SCORE_PCT) * CONDITION_WEIGHT;
}

function referenceLongPeriod(rule: StrategyRule): number {
  return rule.rule_type === "ma_cross" ? rule.rule_params.long_period : rule.rule_params.ma_long;
}

/** 52주(250거래일) 신고가 근접도(60%) + 장기 이평선 상승 기울기(40%). */
function computeTrendScore(prices: DailyPrice[], rule: StrategyRule): number {
  const i = prices.length - 1;
  const windowBars = Math.min(HIGH_LOW_WINDOW_BARS, prices.length);

  let high = -Infinity;
  for (let j = i - windowBars + 1; j <= i; j++) {
    if (prices[j].high > high) high = prices[j].high;
  }
  const price = prices[i].close;
  const proximityScore = (high > 0 ? clamp01(price / high) : 0) * TREND_WEIGHT * 0.6;

  const closes = prices.map((p) => p.close);
  const longSMA = computeSMA(closes, referenceLongPeriod(rule));
  const current = longSMA[i];
  const lookback = Math.min(TREND_SLOPE_LOOKBACK_BARS, i);
  const prev = lookback > 0 ? longSMA[i - lookback] : undefined;

  let slopeScore = 0;
  if (current !== undefined && prev !== undefined && prev !== 0) {
    const slopePct = ((current - prev) / prev) * 100;
    slopeScore = clamp01(slopePct / TREND_SLOPE_FULL_SCORE_PCT) * TREND_WEIGHT * 0.4;
  }

  return proximityScore + slopeScore;
}

/** 최근 20거래일 상승일 거래량 비율(상승일 거래량 / (상승일+하락일 거래량)). 데이터 부족 시 중립(만점의 절반). */
function computeVolumeScore(prices: DailyPrice[]): number {
  const windowBars = Math.min(VOLUME_LOOKBACK_BARS, prices.length - 1);
  if (windowBars <= 0) return VOLUME_WEIGHT / 2;

  let upVolume = 0;
  let downVolume = 0;
  for (let i = prices.length - windowBars; i < prices.length; i++) {
    const diff = prices[i].close - prices[i - 1].close;
    if (diff > 0) upVolume += prices[i].volume;
    else if (diff < 0) downVolume += prices[i].volume;
  }

  const total = upVolume + downVolume;
  if (total === 0) return VOLUME_WEIGHT / 2;

  return (upVolume / total) * VOLUME_WEIGHT;
}

/**
 * 최근 변동성이 낮을수록(60%), 시가총액이 클수록(40%) 고득점. 각 데이터 부족 시 중립(만점의 절반).
 * marketCapRatio01은 호출부가 시장별 기준(원화 "억원" 단위 KR, 달러 단위 US 등)으로
 * 이미 0~1로 정규화해서 넘긴다 — 이 함수는 통화·단위를 모르므로 직접 임계값을 두지 않는다.
 */
function computeStabilityScore(prices: DailyPrice[], marketCapRatio01: number | null): number {
  const windowBars = Math.min(VOLATILITY_LOOKBACK_BARS, prices.length - 1);
  let volatilityScore = STABILITY_WEIGHT * 0.6 * 0.5;

  if (windowBars > 0) {
    const returns: number[] = [];
    for (let i = prices.length - windowBars; i < prices.length; i++) {
      const prevClose = prices[i - 1].close;
      if (prevClose > 0) returns.push((prices[i].close - prevClose) / prevClose);
    }
    if (returns.length > 0) {
      const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
      const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
      const stdDevPct = Math.sqrt(variance) * 100;
      volatilityScore = clamp01(1 - stdDevPct / VOLATILITY_FULL_PENALTY_PCT) * STABILITY_WEIGHT * 0.6;
    }
  }

  const marketCapScore =
    marketCapRatio01 === null
      ? STABILITY_WEIGHT * 0.4 * 0.5
      : clamp01(marketCapRatio01) * STABILITY_WEIGHT * 0.4;

  return volatilityScore + marketCapScore;
}

/**
 * 스크리닝 매칭 종목에 0~100점(정수) 신호 품질 점수를 매긴다.
 * - 조건 충족도(40점): 전략의 핵심 조건을 얼마나 여유 있게 만족하는지
 *   (ma_cross: 단기·장기 이평선 격차 / minervini: 현재가와 이평선들 사이 이격도)
 * - 추세 강도(25점): 52주 신고가 대비 근접도 + 장기 이평선 상승 기울기
 * - 거래량 신뢰도(20점): 최근 20거래일 상승일/하락일 거래량 비율
 * - 안정성(15점): 최근 변동성 + 시가총액 규모
 * marketCapRatio01은 "이 정도면 대형주로 쳐서 만점"이라는 시장별 기준 대비 0~1로 정규화한
 * 값을 호출부가 계산해서 넘긴다(예: KR은 marketCapEok/10000, US는 marketCapUsd/5_000_000_000
 * 등) — 배치의 시세 필터 단계에서 이미 조회한 시가총액을 그대로 재사용한다(추가 API 호출 없음).
 */
export function computeSignalScore(
  prices: DailyPrice[],
  rule: StrategyRule,
  marketCapRatio01: number | null
): number {
  const total =
    computeConditionScore(prices, rule) +
    computeTrendScore(prices, rule) +
    computeVolumeScore(prices) +
    computeStabilityScore(prices, marketCapRatio01);

  return Math.round(Math.min(100, Math.max(0, total)));
}

/** 이 점수 이하인 매칭은 신호 품질이 낮다고 보고 screening_results에 저장하지 않는다
 * (국내/미국 배치 공통 기준). */
export const MIN_SCREENING_SCORE = 50;
