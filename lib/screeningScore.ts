import { computeSMA } from "@/lib/sma";
import { computeRSI } from "@/lib/backtest";
import type { CustomCompositeParams, DailyPrice, StrategyRule } from "@/lib/backtest";
import { buildReversalBreakoutSignalDetails } from "@/lib/reversalBreakout";
import {
  REVERSAL_BREAKOUT_MA_PERIODS,
  BREAKOUT_MA_PERIOD,
  BREAKOUT_LOOKBACK_DAYS,
  ACCUMULATION_VOLUME_MULTIPLIER,
} from "@/lib/reversalBreakoutConfig";

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
const RSI_MARGIN_FULL_SCORE = 10; // RSI가 임계값보다 10 이상 여유 있으면 해당 조건 만점
const VOLUME_SURGE_MARGIN_FULL_SCORE = 1; // 실제 거래량 배율이 요구 배율보다 1배 이상 더 크면 해당 조건 만점
const CUSTOM_COMPOSITE_FALLBACK_LOOKBACK_BARS = 20; // 어떤 조건도 지정되지 않았을 때 쓸 최소 기준 봉 수
const REVERSAL_BREAKOUT_MA20_GAP_FULL_SCORE_PCT = 5; // 현재가가 MA20보다 5% 이상 높으면 조건 충족도 만점

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * custom_composite 조건 충족도: 지정된 조건(ma_cross/rsi/volume_surge)별로 "얼마나 여유
 * 있게 만족하는지"를 0~1로 정규화한 뒤 평균한다. 지정되지 않은 조건은 평균에서 제외한다.
 */
function computeCustomCompositeConditionScore(prices: DailyPrice[], params: CustomCompositeParams): number {
  const closes = prices.map((p) => p.close);
  const volumes = prices.map((p) => p.volume);
  const i = prices.length - 1;
  const subScores: number[] = [];

  if (params.ma_cross) {
    const shortSMA = computeSMA(closes, params.ma_cross.short_period)[i];
    const longSMA = computeSMA(closes, params.ma_cross.long_period)[i];
    if (shortSMA !== undefined && longSMA !== undefined && longSMA !== 0) {
      const gapPct = ((shortSMA - longSMA) / longSMA) * 100;
      subScores.push(clamp01(gapPct / MA_CROSS_GAP_FULL_SCORE_PCT));
    }
  }

  if (params.rsi) {
    const rsiValue = computeRSI(closes, params.rsi.period)[i];
    if (rsiValue !== undefined) {
      const marginPct = params.rsi.direction === "above" ? rsiValue - params.rsi.threshold : params.rsi.threshold - rsiValue;
      subScores.push(clamp01(marginPct / RSI_MARGIN_FULL_SCORE));
    }
  }

  if (params.volume_surge) {
    const avgVolume = computeSMA(volumes, params.volume_surge.period)[i];
    if (avgVolume !== undefined && avgVolume > 0) {
      const actualRatio = volumes[i] / avgVolume;
      subScores.push(clamp01((actualRatio - params.volume_surge.multiplier) / VOLUME_SURGE_MARGIN_FULL_SCORE));
    }
  }

  if (subScores.length === 0) return 0;
  const avgScore = subScores.reduce((a, b) => a + b, 0) / subScores.length;
  return avgScore * CONDITION_WEIGHT;
}

/**
 * reversal_breakout 조건 충족도: MA20 이격도(현재가가 MA20보다 얼마나 높은지) + 전환
 * 신선도(돌파한 지 얼마 안 됐는지, 1에 가까울수록 방금 돌파) + 거래량 배수 여유분
 * (매집봉 거래량이 기준 배수를 얼마나 넘겼는지)을 각각 0~1로 정규화해 평균한다.
 * buildReversalBreakoutSignalDetails가 실제 매칭 판정과 같은 계산 함수를 재사용해
 * 만든 원시값을 그대로 쓴다(재계산하지 않음).
 */
function computeReversalBreakoutConditionScore(prices: DailyPrice[]): number {
  const closes = prices.map((p) => p.close);
  const i = prices.length - 1;
  const details = buildReversalBreakoutSignalDetails(prices);
  const subScores: number[] = [];

  const ma20 = computeSMA(closes, BREAKOUT_MA_PERIOD)[i];
  if (ma20 !== undefined && ma20 > 0) {
    const gapPct = ((closes[i] - ma20) / ma20) * 100;
    subScores.push(clamp01(gapPct / REVERSAL_BREAKOUT_MA20_GAP_FULL_SCORE_PCT));
  }

  if (details.breakout_days_since !== null) {
    subScores.push(clamp01(1 - (details.breakout_days_since - 1) / BREAKOUT_LOOKBACK_DAYS));
  }

  if (details.accumulation_volume_multiple !== null) {
    const marginMultiple = details.accumulation_volume_multiple - ACCUMULATION_VOLUME_MULTIPLIER;
    subScores.push(clamp01(marginMultiple / VOLUME_SURGE_MARGIN_FULL_SCORE));
  }

  if (subScores.length === 0) return 0;
  const avgScore = subScores.reduce((a, b) => a + b, 0) / subScores.length;
  return avgScore * CONDITION_WEIGHT;
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

  if (rule.rule_type === "custom_composite") {
    return computeCustomCompositeConditionScore(prices, rule.rule_params);
  }

  if (rule.rule_type === "reversal_breakout" || rule.rule_type === "reversal_breakout_v2") {
    // 조건 충족도는 MA20 이격도/전환 신선도/거래량 배수 여유분만 보고 역배열비율
    // 임계값(v1 0.7 vs v2 0.9)은 참조하지 않으므로 v1/v2가 동일한 계산을 그대로
    // 재사용할 수 있다.
    return computeReversalBreakoutConditionScore(prices);
  }

  // dh_value_dividend/peg_lynch는 이평선/추세 기반 품질 점수 체계와 안 맞는
  // 전략이라(단일 시점 재무 스냅샷 판정) scripts/screen-all-stocks.ts가 애초에 이
  // 함수를 안 부른다(score를 null로 저장) — 여기 도달하면 호출부 버그이므로 0으로
  // 안전하게 처리한다.
  if (rule.rule_type === "dh_value_dividend" || rule.rule_type === "peg_lynch") return 0;

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
  if (rule.rule_type === "ma_cross") return rule.rule_params.long_period;
  if (rule.rule_type === "minervini_trend_template") return rule.rule_params.ma_long;
  // dh_value_dividend/peg_lynch는 computeConditionScore와 같은 이유로 이 함수까지
  // 오면 안 된다.
  if (rule.rule_type === "dh_value_dividend" || rule.rule_type === "peg_lynch") {
    return CUSTOM_COMPOSITE_FALLBACK_LOOKBACK_BARS;
  }

  // reversal_breakout/reversal_breakout_v2: 역배열 이력 판정에 쓰는 이동평균 중 가장
  // 긴 기간(448일)이 추세 강도(장기 이평선 상승 기울기) 계산의 기준이 된다(v1/v2
  // 공통 — 임계값만 다르고 이동평균 기간은 동일하다).
  if (rule.rule_type === "reversal_breakout" || rule.rule_type === "reversal_breakout_v2") {
    return Math.max(...REVERSAL_BREAKOUT_MA_PERIODS);
  }

  const { ma_cross, rsi, volume_surge } = rule.rule_params;
  return Math.max(
    ma_cross?.long_period ?? 0,
    rsi?.period ?? 0,
    volume_surge?.period ?? 0,
    CUSTOM_COMPOSITE_FALLBACK_LOOKBACK_BARS
  );
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
