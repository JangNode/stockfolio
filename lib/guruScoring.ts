/**
 * [임시 연구 — 병합 금지] 연구 C 점수·순위 계산(순수 함수, I/O 없음). 정의: docs/research/guru-composite-prereg.md 3절.
 * 항목은 "클수록 좋다"로 통일한다(부채비율은 부호를 바꿔 넣는다). 백분위 = (평균 순위 − 0.5) ÷ n, 동점은 평균 순위. 점수 = 묶음 안 항목 백분위의 평균, 종합 = 묶음 점수의 평균(균등).
 */
import type { GuruEvent } from "@/lib/guruFinMetrics";

export type Block = "V" | "Q" | "Gr";
export type BlockItems = Partial<Record<Block, number[]>>;

/** 이벤트와 시총(원)에서 묶음별 항목 값. 계산 불가(조건 위반 포함)이면 그 묶음은 없다. */
export function blockItems(ev: GuruEvent, mcapWon: number): BlockItems {
  const out: BlockItems = {};
  if (!(mcapWon > 0)) return out;
  if (ev.v && ev.v.ni > 0 && ev.v.eq > 0) out.V = [ev.v.eq / mcapWon, ev.v.ni / mcapWon];
  if (ev.q && ev.q.eq > 0 && (ev.q.eq + ev.q.eqPrev) / 2 > 0 && ev.q.rev > 0) out.Q = [ev.q.ni / ((ev.q.eq + ev.q.eqPrev) / 2), ev.q.oi / ev.q.rev, -(ev.q.liab / ev.q.eq), ev.q.posQ];
  if (ev.g && ev.g.revPrev > 0 && ev.g.oiPrev > 0) out.Gr = [ev.g.rev / ev.g.revPrev - 1, ev.g.oi / ev.g.oiPrev - 1];
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
/** 후보 집합(필요한 묶음이 모두 있는 종목)에서 종합 점수 내림차순 순위(1 = 최상, 동점은 코드 오름차순). 입력 종목 중 묶음이 빠진 것은 제외한다. */
export function rankComposite(entries: { code: string; items: BlockItems }[], blocks: readonly Block[]): Ranked[] {
  const cand = entries.filter((e) => blocks.every((b) => e.items[b] !== undefined));
  if (!cand.length) return [];
  const score = new Array<number>(cand.length).fill(0);
  for (const b of blocks) {
    const m = cand[0].items[b]!.length, blockSum = new Array<number>(cand.length).fill(0);
    for (let j = 0; j < m; j++) { const p = percentiles(cand.map((e) => e.items[b]![j])); for (let i = 0; i < cand.length; i++) blockSum[i] += p[i] / m; }
    for (let i = 0; i < cand.length; i++) score[i] += blockSum[i] / blocks.length;
  }
  return cand.map((e, i) => ({ code: e.code, score: score[i], rank: 0 })).sort((a, b) => b.score - a.score || (a.code < b.code ? -1 : 1)).map((r, i) => ({ ...r, rank: i + 1 }));
}
