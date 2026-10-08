import test from "node:test";
import assert from "node:assert/strict";
import { applyMaCrossV2, isMaCrossV2Signal, maCrossBacktestMinRows, MA_CROSS_V2_PARAMS, MA_CROSS_V2_SIGNAL_DETAILS } from "@/lib/maCrossConfig";

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
