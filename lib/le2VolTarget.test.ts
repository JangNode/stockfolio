import test from "node:test";
import assert from "node:assert/strict";
import { alignCloses, equalWeightSigma, volMultiplier } from "@/lib/le2VolTarget";

const near = (a: number, b: number, eps = 1e-12): void => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);

test("alignCloses: 행이 없는 날은 직전 종가를 이어 쓰고 첫 행 이전은 NaN", () => {
  const cal = ["d0", "d1", "d2", "d3"];
  const out = alignCloses(cal, new Map([["d1", 0], ["d3", 1]]), Float64Array.from([10, 12]));
  assert.ok(Number.isNaN(out[0]));
  assert.deepEqual([out[1], out[2], out[3]], [10, 10, 12]);
});

test("equalWeightSigma: 일정한 일수익률이면 σ = 0, 번갈아 ±1%면 표본표준편차 × √252", () => {
  const n = 30, flat = new Float64Array(n), alt = new Float64Array(n);
  let p = 100, q = 100;
  for (let t = 0; t < n; t++) { flat[t] = p; p *= 1.01; alt[t] = q; q *= t % 2 === 0 ? 1.01 : 0.99; }
  near(equalWeightSigma([flat], 29, 20, 252), 0, 1e-12);
  // alt의 일수익률: t=1..29에서 t홀수 → alt[t]/alt[t-1] = 1.01(전 t-1이 짝수), t짝수 → 0.99. 창 t=10..29: +1% 10개, −1% 10개 → 표본표준편차 = sqrt(20×0.0001/19)
  const expected = Math.sqrt((20 * 0.0001) / 19) * Math.sqrt(252);
  near(equalWeightSigma([alt], 29, 20, 252), expected, 1e-6);
});

test("equalWeightSigma: 동일 비중이라 서로 반대로 움직이는 두 종목이면 변동성이 상쇄된다", () => {
  const n = 30, up = new Float64Array(n), dn = new Float64Array(n);
  let a = 100, b = 100;
  for (let t = 0; t < n; t++) { up[t] = a; dn[t] = b; a *= t % 2 === 0 ? 1.01 : 0.99; b *= t % 2 === 0 ? 0.99 : 1.01; }
  assert.ok(equalWeightSigma([up, dn], 29, 20, 252) < equalWeightSigma([up], 29, 20, 252) / 50);
});

test("equalWeightSigma: 창 시작 이전에 행이 없던 종목은 제외, 쓸 종목이 없거나 c < window이면 NaN", () => {
  const n = 30, ok = new Float64Array(n).map((_, t) => 100 + (t % 2 === 0 ? 1 : -1)), late = new Float64Array(n).fill(NaN);
  for (let t = 15; t < n; t++) late[t] = 50;
  near(equalWeightSigma([ok, late], 29, 20, 252), equalWeightSigma([ok], 29, 20, 252), 1e-12);
  assert.ok(Number.isNaN(equalWeightSigma([late], 29, 20, 252)));
  assert.ok(Number.isNaN(equalWeightSigma([ok], 10, 20, 252)));
});

test("volMultiplier: min(1, 목표 ÷ σ)를 소수 둘째 자리로 반올림, σ 없음·0이면 1", () => {
  assert.equal(volMultiplier(0.4, 0.2, 2), 0.5);
  assert.equal(volMultiplier(0.3, 0.2, 2), 0.67); // 0.6667 → 0.67
  assert.equal(volMultiplier(0.35, 0.25, 2), 0.71); // 0.7143 → 0.71
  assert.equal(volMultiplier(0.1, 0.2, 2), 1);
  assert.equal(volMultiplier(0, 0.2, 2), 1);
  assert.equal(volMultiplier(NaN, 0.2, 2), 1);
  assert.equal(volMultiplier(5, 0.2, 2), 0.04);
});
