import test from "node:test";
import assert from "node:assert/strict";
import { ensembleScoreOf, outsiderEnsembleRank, rankEnsemble } from "@/lib/momentumEnsemble";

const near = (a: number, b: number): void => assert.ok(Math.abs(a - b) < 1e-12, `${a} ≠ ${b}`);

test("세 구간 백분위의 단순 평균으로 정렬한다", () => {
  const r = rankEnsemble([
    { code: "A", rets: [0.3, 0.3, 0.3] },
    { code: "B", rets: [0.2, 0.2, 0.2] },
    { code: "C", rets: [0.1, 0.1, 0.1] },
    { code: "D", rets: [0.4, 0.0, 0.05] },
  ]);
  // n=4, 백분위 = (낮은 수 + 0.5) ÷ 4. A: 낮은 수 2·3·3, D: 3·0·0, B: 1·2·2, C: 0·1·0 (3개월, 6개월, 12-1개월 순)
  near(r.items.find((x) => x.code === "A")!.score, (2.5 + 3.5 + 3.5) / 3 / 4);
  near(r.items.find((x) => x.code === "D")!.score, (3.5 + 0.5 + 0.5) / 3 / 4);
  assert.deepEqual(r.items.map((x) => x.code), ["A", "B", "D", "C"]);
  assert.equal(r.rank.get("B"), 2);
});

test("점수가 같으면 입력 순서(시총 순위가 앞선 쪽)가 먼저이고 같은 수는 중간 순위로 센다", () => {
  const r = rankEnsemble([{ code: "X", rets: [0.1, 0.1, 0.1] }, { code: "Y", rets: [0.1, 0.1, 0.1] }]);
  assert.deepEqual(r.items.map((x) => x.code), ["X", "Y"]);
  near(r.items[0].score, 0.5); // 낮은 수 0, 같은 수 2 → (0 + 0.5×2) ÷ 2
});

test("풀 밖 종목은 풀에 끼워 넣은 것처럼 점수를 내고 순위는 엄격히 높은 점수 수 + 1", () => {
  const r = rankEnsemble([{ code: "A", rets: [0.3, 0.3, 0.3] }, { code: "B", rets: [0.2, 0.2, 0.2] }, { code: "C", rets: [0.1, 0.1, 0.1] }]);
  near(ensembleScoreOf([0.2, 0.2, 0.2], r.legSorted, r.n, false), 2 / 3); // 낮은 1, 같은 1 → (1 + 0.5 + 0.5) ÷ 3 (B 자신의 점수는 0.5)
  assert.equal(outsiderEnsembleRank(r, [0.2, 0.2, 0.2]), 2); // A(5/6)만 더 높다
  assert.equal(outsiderEnsembleRank(r, [0.9, 0.9, 0.9]), 1);
  assert.equal(outsiderEnsembleRank(r, [-1, -1, -1]), 3); // 풀 최하위 C와 점수가 같으면 엄격히 높은 쪽만 세므로 C보다 앞선다
});
