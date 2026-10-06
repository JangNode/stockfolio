import { test } from "node:test";
import assert from "node:assert/strict";
import { latestRuleType, matchesSourceRuleTypes } from "./strategyVersions";

test("계보 안의 어떤 버전 키든 최신 버전으로 해석한다", () => {
  assert.equal(latestRuleType("reversal_breakout"), "reversal_breakout_v2");
  assert.equal(latestRuleType("reversal_breakout_v2"), "reversal_breakout_v2");
  assert.equal(latestRuleType("ma_cross"), "ma_cross");
});

test("계보에 없는(종료된) 전략은 해석되지 않는다", () => {
  assert.equal(latestRuleType("minervini_trend_template"), null);
  assert.equal(latestRuleType("custom_composite"), null);
});

test("v1을 출처로 둔 스타일은 최신 버전(v2)의 신호만 후보로 삼는다", () => {
  assert.equal(matchesSourceRuleTypes(["reversal_breakout"], "reversal_breakout_v2"), true);
  assert.equal(matchesSourceRuleTypes(["reversal_breakout"], "reversal_breakout"), false); // 구버전 신호는 제외
  assert.equal(matchesSourceRuleTypes(["reversal_breakout_v2"], "reversal_breakout_v2"), true);
});

test("출처 목록에 없는 계보와 종료된 전략의 신호는 제외한다", () => {
  assert.equal(matchesSourceRuleTypes(["ma_cross", "minervini_trend_template"], "minervini_trend_template"), false);
  assert.equal(matchesSourceRuleTypes(["ma_cross"], "peg_lynch"), false);
  assert.equal(matchesSourceRuleTypes(["ma_cross", "peg_lynch"], "peg_lynch"), true);
});
