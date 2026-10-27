/**
 * [임시 연구 — 병합 금지] 연구 C 점수·순위 계산(순수 함수, I/O 없음). 정의: docs/research/guru-composite-prereg.md 4절.
 * 항목은 "클수록 좋다"로 통일한다(부채비율은 부호를 바꿔 넣는다). 백분위 = (평균 순위 − 0.5) ÷ n, 동점은 평균 순위. 점수 = 묶음 안 항목 백분위의 평균, 종합 = 묶음 점수의 평균(균등).
 */
import type { GuruEvent, GuruAnnualEvent } from "@/lib/guruFinMetrics";

export type Block = "V" | "Q" | "Qp" | "Gr";
export type BlockItems = Partial<Record<Block, number[]>>;

/** 이벤트(V·Q는 분기 흐름, Gr는 사업보고서 흐름)와 시총(원)에서 묶음별 항목 값. 계산 불가(조건 위반 포함)이면 그 묶음은 없다. */
export function blockItems(qev: GuruEvent | null, aev: GuruAnnualEvent | null, mcapWon: number): BlockItems {
  const out: BlockItems = {};
  if (!(mcapWon > 0)) return out;
  if (qev?.v && qev.v.ni > 0 && qev.v.eq > 0) out.V = [qev.v.eq / mcapWon, qev.v.ni / mcapWon];
  const q = qev?.q;
  if (q && q.eq > 0 && (q.eq + q.eqPrev) / 2 > 0 && q.rev > 0) out.Q = [q.ni / ((q.eq + q.eqPrev) / 2), q.oi / q.rev, -(q.liab / q.eq), q.posQ];
  const qp = qev?.qp;
  if (qp && qp.eq > 0 && (qp.eq + qp.eqPrev) / 2 > 0 && qp.rev > 0) out.Qp = [qp.ni / ((qp.eq + qp.eqPrev) / 2), qp.oi / qp.rev, -(qp.liab / qp.eq)];
  const g = aev?.g;
  if (g && g.revPrev > 0 && g.oiPrev > 0) out.Gr = [g.rev / g.revPrev - 1, g.oi / g.oiPrev - 1];
  return out;
}

/** 값 배열의 백분위(평균 순위 방식, 0~1, 클수록 좋음). */
export function percentiles(vals: number[]): number[] {
  const n = vals.length, order = vals.map((_, i) => i).sort((a, b) => vals[a] - vals[b] || a - b);
  const out = new Array<number>(n);
  for (let i = 0; i < n;) {
    let j = i;
    while (j + 1 < n && vals[order[j + 1]] === vals[order[i]]) j++;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[order[k]] = (avgRank - 0.5) / n;
    i = j + 1;
  }
  return out;
}

export interface Ranked { code: string; score: number; rank: number }
export interface RankResult {
  ranked: Ranked[];
  /** 후보 집합에 들지 못했지만 점수를 매겨야 하는 종목(예: SMALL 시총 상한 초과 보유 종목)의 순위. 필요한 묶음이 빠졌거나 후보 집합이 비면 undefined. */
  rankOutsider: (items: BlockItems) => number | undefined;
}
/**
 * 후보 집합(필요한 묶음이 모두 있는 종목)에서 종합 점수 내림차순 순위(1 = 최상, 동점은 코드 오름차순).
 * rankOutsider = 후보 집합의 값에 끼워 넣었을 때의 백분위((더 낮은 값 수 + 같은 값 수 ÷ 2) ÷ n)로 점수를 내고, 순위 = 1 + 점수가 더 높은 후보 수.
 */
export function rankComposite(entries: { code: string; items: BlockItems }[], blocks: readonly Block[]): RankResult {
  const cand = entries.filter((e) => blocks.every((b) => e.items[b] !== undefined));
  if (!cand.length) return { ranked: [], rankOutsider: () => undefined };
  const n = cand.length, score = new Array<number>(n).fill(0);
  const cols: number[][][] = []; // 묶음 → 항목 → 오름차순 정렬 값
  blocks.forEach((b, bi) => {
    const m = cand[0].items[b]!.length, blockSum = new Array<number>(n).fill(0);
    cols[bi] = [];
    for (let j = 0; j < m; j++) {
      const v = cand.map((e) => e.items[b]![j]), p = percentiles(v);
      cols[bi][j] = [...v].sort((x, y) => x - y);
      for (let i = 0; i < n; i++) blockSum[i] += p[i] / m;
    }
    for (let i = 0; i < n; i++) score[i] += blockSum[i] / blocks.length;
  });
  const ranked = cand.map((e, i) => ({ code: e.code, score: score[i], rank: 0 })).sort((a, b) => b.score - a.score || (a.code < b.code ? -1 : 1)).map((r, i) => ({ ...r, rank: i + 1 }));
  const rankOutsider = (items: BlockItems): number | undefined => {
    if (!blocks.every((b) => items[b] !== undefined)) return undefined;
    let s = 0;
    blocks.forEach((b, bi) => {
      const m = cols[bi].length;
      let bs = 0;
      for (let j = 0; j < m; j++) {
        const arr = cols[bi][j], x = items[b]![j];
        let lo = 0, hi = n; while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < x) lo = mid + 1; else hi = mid; }
        let up = lo; while (up < n && arr[up] === x) up++;
        bs += (lo + (up - lo) / 2) / n / m;
      }
      s += bs / blocks.length;
    });
    let better = 0;
    for (const r of ranked) { if (r.score > s) better++; else break; }
    return 1 + better;
  };
  return { ranked, rankOutsider };
}
