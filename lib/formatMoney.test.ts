import { test } from "node:test";
import assert from "node:assert/strict";
import { formatMoney } from "./formatNumber";

test("원화는 반올림한 정수 + 천 단위 콤마 + 원", () => {
  assert.equal(formatMoney(5024.134836, "KR"), "5,024원");
  assert.equal(formatMoney(59811.129, "KR"), "59,811원");
  assert.equal(formatMoney(1234567.891, "KR"), "1,234,568원");
  assert.equal(formatMoney(28410.5, "KR"), "28,411원");
  assert.equal(formatMoney(0, "KR"), "0원");
});

test("반올림 결과가 0이면 -0이 아니라 0원", () => {
  assert.equal(formatMoney(-0.4, "KR"), "0원");
});

test("sign 옵션: 반올림 후 양수일 때만 +, 음수는 - 그대로", () => {
  assert.equal(formatMoney(1234.567, "KR", { sign: true }), "+1,235원");
  assert.equal(formatMoney(-1234.567, "KR", { sign: true }), "-1,235원");
  assert.equal(formatMoney(0.3, "KR", { sign: true }), "0원");
});

test("미국(USD)은 기존대로 소수 2자리", () => {
  assert.equal(formatMoney(1234.5, "US"), "$1,234.50");
  assert.equal(formatMoney(12.345, "US", { sign: true }), "+$12.35");
});
