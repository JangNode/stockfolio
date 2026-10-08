import test from "node:test";
import assert from "node:assert/strict";
import {
  applyMaCrossV2,
  isMaCrossV2Signal,
  isScoreGateExempt,
  maCrossBacktestMinRows,
  MA_CROSS_KR_MIN_MARKET_CAP_EOK,
  MA_CROSS_V2_PARAMS,
  MA_CROSS_V2_SIGNAL_DETAILS,
} from "@/lib/maCrossConfig";
import {
  STRATEGY_BACKTEST_DISPLAY_STAGE,
  STRATEGY_BACKTEST_EXTENDED_RULE_TYPES,
  STRATEGY_BACKTEST_EXTENDED_STAGE,
  STRATEGY_BACKTEST_EXTENDED_WINDOW_START_YEAR,
  STRATEGY_BACKTEST_TARGET_RULE_TYPES,
  STRATEGY_BACKTEST_WINDOW_START_YEAR,
} from "@/lib/strategyBacktestSummaryConfig";

test("ma_cross는 DB의 rule_params와 무관하게 50/200으로 덮어쓴다", () => {
  const out = applyMaCrossV2({ rule_type: "ma_cross", rule_params: { short_period: 5, long_period: 20 } });
  assert.deepEqual(out.rule_params, { short_period: 50, long_period: 200 });
  assert.deepEqual(MA_CROSS_V2_PARAMS, { short_period: 50, long_period: 200 });
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

test("화면 백테스트 일봉 요청 건수: 기간 + 장기 이평선 워밍업", () => {
  assert.equal(maCrossBacktestMinRows(24), 24 * 21 + 200 + 20);
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
