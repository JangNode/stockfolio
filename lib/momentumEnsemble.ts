// 연구 LE 모멘텀 앙상블 점수(순수 함수). 정의: docs/research/momentum-ensemble-prereg.md 3절.
export interface EnsembleItem { code: string; rets: number[] }
export interface EnsembleRanking {
  /** 앙상블 점수 내림차순(동점이면 입력 순서 = 시총 순위가 앞선 쪽 먼저). */
  items: { code: string; score: number; rets: number[] }[];
  rank: Map<string, number>;
  /** 내림차순 점수 배열(풀 밖 종목의 순위 계산용). */
  scores: number[];
  /** 구간별 오름차순 수익률(백분위 계산용). */
  legSorted: number[][];
  n: number;
}

const lowerCount = (a: number[], x: number): number => { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; } return lo; };
const upperCount = (a: number[], x: number): number => { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] <= x) lo = m + 1; else hi = m; } return lo; };

/**
 * 구간별 백분위(0~1) = (모집단에서 더 낮은 수 + 0.5 × 같은 수 [+ 0.5, 풀 밖 종목]) ÷ 모집단 크기 n. 풀 구성원은 자기 자신이 "같은 수"에 들어 있고,
 * 풀 밖 종목은 자기를 따로 +0.5로 센다 — 같은 식이라 "풀에 끼워 넣은" 점수와 일치한다. 점수 = 세 구간 백분위의 단순 평균.
 */
export function ensembleScoreOf(rets: number[], legSorted: number[][], n: number, isMember: boolean): number {
  let sum = 0;
  for (let k = 0; k < rets.length; k++) {
    const lo = lowerCount(legSorted[k], rets[k]), eq = upperCount(legSorted[k], rets[k]) - lo;
    sum += (lo + 0.5 * eq + (isMember ? 0 : 0.5)) / n;
  }
  return sum / rets.length;
}

/** 모든 구간 수익률이 유한한 풀 구성원만 받아 앙상블 순위를 만든다. */
export function rankEnsemble(items: EnsembleItem[]): EnsembleRanking {
  const n = items.length, legs = items[0]?.rets.length ?? 0;
  const legSorted: number[][] = [];
  for (let k = 0; k < legs; k++) legSorted.push(items.map((x) => x.rets[k]).sort((a, b) => a - b));
  const scored = items.map((x, i) => ({ code: x.code, rets: x.rets, score: ensembleScoreOf(x.rets, legSorted, n, true), i }));
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return { items: scored.map(({ code, score, rets }) => ({ code, score, rets })), rank: new Map(scored.map((x, k) => [x.code, k + 1])), scores: scored.map((x) => x.score), legSorted, n };
}

/** 풀 밖 보유 종목의 앙상블 순위 = 1 + 풀에서 점수가 더 높은(엄격) 종목 수. */
export function outsiderEnsembleRank(r: EnsembleRanking, rets: number[]): number {
  const score = ensembleScoreOf(rets, r.legSorted, r.n, false);
  let lo = 0, hi = r.scores.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (r.scores[m] > score) lo = m + 1; else hi = m; }
  return 1 + lo;
}
