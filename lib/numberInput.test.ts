import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInputValue, toInputValue } from "./numberInput";

test("빈 입력은 0이 아니라 NaN으로 두고, NaN은 빈 문자열로 렌더링한다", () => {
  assert.ok(Number.isNaN(parseInputValue("")));
  assert.equal(toInputValue(NaN), "");
});

test("입력값은 숫자로 변환하고 0은 빈 칸이 아니라 0으로 표시한다", () => {
  assert.equal(parseInputValue("20"), 20);
  assert.equal(parseInputValue("0"), 0);
  assert.equal(parseInputValue("1.5"), 1.5);
  assert.equal(toInputValue(0), 0);
  assert.equal(toInputValue(14), 14);
});

test("20을 지우고 2를 입력해도 02가 되지 않는다", () => {
  const afterErase = parseInputValue("");
  assert.equal(toInputValue(afterErase), "");
  assert.equal(toInputValue(parseInputValue("2")), 2);
});
