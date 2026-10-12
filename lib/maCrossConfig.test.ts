import test from "node:test";
import assert from "node:assert/strict";
import {
  applyMaCrossV2,
  applyMaCrossV3,
  computeNearHighGap,
  isMaCrossPaperCandidateSignal,
  isMaCrossV2Signal,
  isMaCrossV3Signal,
  isScoreGateExempt,
  maCrossBacktestMinRows,
  passesMaCrossNearHighFilter,
  MA_CROSS_KR_MIN_MARKET_CAP_EOK,
  MA_CROSS_NEAR_HIGH_LOOKBACK_BARS,
  MA_CROSS_NEAR_HIGH_MIN_GAP,
  MA_CROSS_V2_PARAMS,
  MA_CROSS_V2_SIGNAL_DETAILS,
  MA_CROSS_V3_PARAMS,
  MA_CROSS_V3_SIGNAL_DETAILS,
} from "@/lib/maCrossConfig";
import type { DailyPrice } from "@/lib/backtest";
import {
  STRATEGY_BACKTEST_DISPLAY_STAGE,
  STRATEGY_BACKTEST_EXTENDED_RULE_TYPES,
  STRATEGY_BACKTEST_EXTENDED_STAGE,
  STRATEGY_BACKTEST_EXTENDED_WINDOW_START_YEAR,
  STRATEGY_BACKTEST_SIGNAL_LIMITED_FROM,
  STRATEGY_BACKTEST_SIGNAL_START_RULE_TYPES,
  STRATEGY_BACKTEST_SIGNAL_START_STAGE,
  getSignalStartDate,
  STRATEGY_BACKTEST_TARGET_RULE_TYPES,
  STRATEGY_BACKTEST_WINDOW_START_YEAR,
} from "@/lib/strategyBacktestSummaryConfig";

test("ma_cross는 DB의 rule_params와 무관하게 50/200으로 덮어쓴다", () => {
  const out = applyMaCrossV2({ rule_type: "ma_cross", rule_params: { short_period: 5, long_period: 20 } });
  assert.deepEqual(out.rule_params, { short_period: 50, long_period: 200 });
  assert.deepEqual(MA_CROSS_V2_PARAMS, { short_period: 50, long_period: 200 });
});

test("v3도 DB의 rule_params와 무관하게 50/200으로 덮어쓰고(v2/v3 스위치 없음), 다른 전략은 그대로 둔다", () => {
  const out = applyMaCrossV3({ rule_type: "ma_cross", rule_params: { short_period: 5, long_period: 20 } });
  assert.deepEqual(out.rule_params, { short_period: 50, long_period: 200 });
  assert.deepEqual(MA_CROSS_V3_PARAMS, { short_period: 50, long_period: 200 });
  const peg = { rule_type: "peg_lynch", rule_params: {} } as const;
  assert.equal(applyMaCrossV3(peg), peg);
});

test("다른 전략은 그대로 둔다", () => {
  const peg = { rule_type: "peg_lynch", rule_params: {} } as const;
  assert.equal(applyMaCrossV2(peg), peg);
});

test("신호 표식: v2 표식이 있는 신호만 새 규칙으로 본다", () => {
  assert.equal(isMaCrossV2Signal(MA_CROSS_V2_SIGNAL_DETAILS), true);
  assert.equal(isMaCrossV2Signal(null), false);
  assert.equal(isMaCrossV2Signal({}), false);
  assert.equal(isMaCrossV2Signal({ rule_version: "v1" }), false);
});

test("v3 표식: v3만 v3, v2 표식과 구 규칙(표식 없음)은 구분되고 모의투자 후보는 v2·v3만", () => {
  assert.equal(isMaCrossV3Signal(MA_CROSS_V3_SIGNAL_DETAILS), true);
  assert.equal(isMaCrossV3Signal(MA_CROSS_V2_SIGNAL_DETAILS), false);
  assert.equal(isMaCrossV3Signal(null), false);
  assert.equal(isMaCrossV3Signal({}), false);
  assert.equal(isMaCrossV2Signal(MA_CROSS_V3_SIGNAL_DETAILS), false);
  assert.equal(MA_CROSS_V3_SIGNAL_DETAILS.exit_rule, "signal");
  assert.equal(isMaCrossPaperCandidateSignal(MA_CROSS_V3_SIGNAL_DETAILS), true);
  assert.equal(isMaCrossPaperCandidateSignal(MA_CROSS_V2_SIGNAL_DETAILS), true);
  assert.equal(isMaCrossPaperCandidateSignal(null), false);
  assert.equal(isMaCrossPaperCandidateSignal({ rule_version: "v1" }), false);
});

// 52주 고가 필터: 고가 창 = 신호 봉 포함 최근 252개 봉의 high (research R1b/F3와 동일), 종가/고가 - 1 > -0.1829 일 때만 통과.
function barsWithHigh(length: number, highAt: number, high: number, closeAtEnd: number): DailyPrice[] {
  return Array.from({ length }, (_, i) => ({
    date: `2020-01-${String((i % 28) + 1).padStart(2, "0")}`,
    open: 50,
    high: i === highAt ? high : 60,
    low: 40,
    close: i === length - 1 ? closeAtEnd : 50,
    volume: 1000,
  }));
}

test("52주 고가 필터 경계값: -18.29% 직전은 탈락, 직후는 통과", () => {
  assert.equal(MA_CROSS_NEAR_HIGH_MIN_GAP, -0.1829);
  assert.equal(MA_CROSS_NEAR_HIGH_LOOKBACK_BARS, 252);
  const prices = (close: number) => barsWithHigh(300, 100, 100, close);
  // 고가 100 → 종가 81.71이 정확히 -18.29%. 81.70(-18.30%)은 탈락, 81.72(-18.28%)는 통과.
  assert.equal(passesMaCrossNearHighFilter(prices(81.7), 299), false);
  assert.equal(passesMaCrossNearHighFilter(prices(81.72), 299), true);
  assert.ok(Math.abs(computeNearHighGap(prices(90), 299) - -0.1) < 1e-12);
  assert.equal(passesMaCrossNearHighFilter(prices(100), 299), true);
});

test("52주 고가 필터: 고가 창은 신호 봉 포함 252개 봉이다(253번째 전 봉의 고가는 제외)", () => {
  // 신호 봉(299) 기준 창은 index 48..299. 고가가 index 47에 있으면 제외돼 필터를 통과하고, index 48이면 포함돼 탈락한다.
  assert.equal(passesMaCrossNearHighFilter(barsWithHigh(300, 47, 100, 70), 299), true); // 창 최고가 60 → 70/60-1 > 0
  assert.equal(passesMaCrossNearHighFilter(barsWithHigh(300, 48, 100, 70), 299), false); // 70/100-1 = -30%
  // 신호 봉 자신의 고가도 창에 포함된다.
  const own = barsWithHigh(300, 299, 100, 70);
  assert.equal(passesMaCrossNearHighFilter(own, 299), false);
});

test("52주 고가 필터: 봉이 252개 미만이면 있는 만큼으로 계산한다", () => {
  const short = barsWithHigh(210, 5, 100, 90);
  assert.equal(passesMaCrossNearHighFilter(short, 209), true); // 90/100 - 1 = -10%
});

test("화면 백테스트 일봉 요청 건수: 기간 + 장기 이평선·52주 고가 창 중 큰 쪽 + 여유", () => {
  assert.equal(maCrossBacktestMinRows(24), 24 * 21 + 252 + 20);
  assert.ok(maCrossBacktestMinRows(24) <= 800); // 일봉 조회 상한(8페이지 × 100건) 이내
});

test("점수 게이트는 ma_cross만 면제한다", () => {
  assert.equal(isScoreGateExempt("ma_cross"), true);
  for (const other of ["peg_lynch", "reversal_breakout_v2", "reversal_breakout", "minervini_trend_template"]) {
    assert.equal(isScoreGateExempt(other), false);
  }
});

test("KR 후보 시총 하한은 검증 유니버스(5천억)와 같다", () => {
  assert.equal(MA_CROSS_KR_MIN_MARKET_CAP_EOK, 5000);
});

test("확장 기간(2010~) 설정: 화면 기본 stage와 다른 stage, 대상은 운영 전략의 부분집합, 시작 연도가 더 이르다", () => {
  assert.notEqual(STRATEGY_BACKTEST_EXTENDED_STAGE, STRATEGY_BACKTEST_DISPLAY_STAGE);
  for (const t of STRATEGY_BACKTEST_EXTENDED_RULE_TYPES) assert.ok((STRATEGY_BACKTEST_TARGET_RULE_TYPES as readonly string[]).includes(t));
  assert.ok(STRATEGY_BACKTEST_EXTENDED_WINDOW_START_YEAR < STRATEGY_BACKTEST_WINDOW_START_YEAR);
});

test("신호 기간 기준 stage: 시작일은 신호 제한 월의 1일, 대상은 신호 제한이 있는 전략, stage는 다른 stage와 겹치지 않는다", () => {
  assert.equal(getSignalStartDate("peg_lynch"), "2021-03-01");
  assert.equal(getSignalStartDate("ma_cross"), null);
  for (const t of STRATEGY_BACKTEST_SIGNAL_START_RULE_TYPES) assert.ok(STRATEGY_BACKTEST_SIGNAL_LIMITED_FROM[t]);
  assert.notEqual(STRATEGY_BACKTEST_SIGNAL_START_STAGE, STRATEGY_BACKTEST_EXTENDED_STAGE);
  assert.notEqual(STRATEGY_BACKTEST_SIGNAL_START_STAGE, STRATEGY_BACKTEST_DISPLAY_STAGE);
});
