import { test } from "node:test";
import assert from "node:assert/strict";
import { selectLatestBenchmarks, selectLatestSummaries } from "./strategyBacktestSelection";

const row = (rule_type: string, stage: string | null, id: string) => ({ rule_type, market: "KR", data_widen_stage: stage, id });

test("지정 stage 행만 조합별 최신(입력 순서상 첫 행) 하나씩 고르고, 없는 전략은 빠진다", () => {
  const rows = [
    row("ma_cross", "pit_adjusted_cap5000", "new-ma"),
    row("ma_cross", "pit_adjusted", "other-ma"),
    row("ma_cross", "pit_adjusted_cap5000", "old-ma"),
    row("peg_lynch", "pit_adjusted", "other-peg"),
  ];
  const picked = selectLatestSummaries(rows, "pit_adjusted_cap5000");
  assert.deepEqual(picked.map((r) => r.id), ["new-ma"]);
});

test("narrow를 가리키면 stage가 비어 있는 기존 행도 포함한다", () => {
  const picked = selectLatestSummaries([row("ma_cross", null, "legacy"), row("peg_lynch", "narrow", "n")], "narrow");
  assert.deepEqual(picked.map((r) => r.id).sort(), ["legacy", "n"]);
});

test("벤치마크는 카드 대상 종류만 종류별 최신 하나씩 고른다", () => {
  const b = (benchmark_type: string, stage: string | null, id: string) => ({ benchmark_type, data_widen_stage: stage, id });
  const picked = selectLatestBenchmarks(
    [
      b("kospi", "pit_adjusted_cap5000", "k1"),
      b("kospi", "pit_adjusted_cap5000", "k0"),
      b("universe_monthly_rebalance_liq_1e8", "pit_adjusted_cap5000", "sens"),
      b("universe_monthly_rebalance", "pit_adjusted_cap5000", "u"),
    ],
    "pit_adjusted_cap5000"
  );
  assert.deepEqual(picked.map((r) => r.id).sort(), ["k1", "u"]);
});
