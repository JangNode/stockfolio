import test from "node:test";
import assert from "node:assert/strict";
import { absMomentumTriggered, legReturn } from "@/lib/le2AbsMomentum";
import { AM_CANDS } from "@/lib/le2AbsMomentumConfig";

test("legReturn: close[i−skip] ÷ close[i−lookback] − 1, 행이 부족하면 NaN", () => {
  const close = Float64Array.from({ length: 300 }, (_, k) => 100 + k);
  assert.equal(legReturn(close, 299, { lookback: 252, skip: 21 }), close[278] / close[47] - 1);
  assert.ok(Number.isNaN(legReturn(close, 100, { lookback: 252, skip: 21 })));
  assert.ok(Number.isNaN(legReturn(Float64Array.from([0, 0, 5]), 2, { lookback: 2, skip: 0 })));
});

test("absMomentumTriggered: 0 이하이면 발동(0 포함), 다수결(2/3), 계산 불가면 null", () => {
  assert.equal(absMomentumTriggered([0.05], 1), false);
  assert.equal(absMomentumTriggered([0], 1), true); // 0 이하
  assert.equal(absMomentumTriggered([-0.01], 1), true);
  assert.equal(absMomentumTriggered([-0.1, 0.2, 0.3], 2), false); // 1개만 0 이하
  assert.equal(absMomentumTriggered([-0.1, -0.2, 0.3], 2), true);
  assert.equal(absMomentumTriggered([-0.1, 0, 0.3], 2), true);
  assert.equal(absMomentumTriggered([-0.1, NaN, 0.3], 2), null);
  assert.equal(absMomentumTriggered([], 1), null);
});

test("후보 설정: AM1 단일 12-1, AM2 세 구간 다수결(2), AM3 6개월(126−5), 이웃은 각 2개", () => {
  assert.deepEqual(AM_CANDS.AM1.legs, [{ lookback: 252, skip: 21 }]);
  assert.equal(AM_CANDS.AM2.legs.length, 3);
  assert.equal(AM_CANDS.AM2.minNeg, 2);
  assert.deepEqual(AM_CANDS.AM3.legs, [{ lookback: 126, skip: 5 }]);
  for (const c of Object.values(AM_CANDS)) assert.equal(c.neighbors.length, 2);
  assert.deepEqual(AM_CANDS.AM1.neighbors.map((n) => n.legs[0].lookback), [189, 315]);
  assert.deepEqual(AM_CANDS.AM2.neighbors.map((n) => n.legs.map((l) => l.lookback)), [[42, 105, 189], [84, 147, 315]]);
  assert.deepEqual(AM_CANDS.AM3.neighbors.map((n) => n.legs[0].lookback), [90, 180]);
});
