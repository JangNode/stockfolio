import { test } from "node:test";
import assert from "node:assert/strict";
import { benchmarkVerdict, isLowSampleSize, periodYears } from "./strategyBacktestBadges";

test("벤치마크 CAGR 이상이면 우세, 미만이면 열세, 값이 없으면 배지 없음", () => {
  assert.equal(benchmarkVerdict(10, 8), "ahead");
  assert.equal(benchmarkVerdict(8, 8), "ahead");
  assert.equal(benchmarkVerdict(-2.5, 3.6), "behind");
  assert.equal(benchmarkVerdict(null, 3.6), null);
  assert.equal(benchmarkVerdict(3.6, null), null);
});

test("기간 연수는 날짜 차를 365.25일로 나눈다", () => {
  assert.ok(Math.abs(periodYears("2016-01-01", "2026-01-01") - 10) < 0.01);
});

test("총 거래 수가 연 20건 × 기간 연수보다 적으면 표본 적음", () => {
  // 10년 → 기준 약 200건
  assert.equal(isLowSampleSize(199, "2016-01-01", "2026-01-01", 20), true);
  assert.equal(isLowSampleSize(205, "2016-01-01", "2026-01-01", 20), false);
});
