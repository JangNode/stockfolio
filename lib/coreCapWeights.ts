// 연구 DS9 코어 종목당 상한 비중 계산(순수 함수). 정의: docs/research/ds8-ds9-prereg.md
/**
 * 시총 mc[]에 비례한 비중에서 종목당 상한 cap을 넘는 종목은 cap에 고정하고, 남은 몫(1 − cap × 고정된 종목 수)을
 * 고정되지 않은 종목들에 시총 비례로 다시 나눈다. 나눈 뒤 새로 cap을 넘는 종목이 생기면 같은 방식으로 반복한다.
 * cap × 종목 수 < 1이면(상한을 지킬 수 없음) 던진다. 합은 1이다.
 */
export function capWeights(mc: readonly number[], cap: number): number[] {
  const n = mc.length;
  if (!(n > 0) || !mc.every((x) => Number.isFinite(x) && x > 0)) throw new Error("시총 값이 올바르지 않다");
  if (cap * n < 1 - 1e-12) throw new Error(`상한 ${cap} × 종목 ${n} < 1 — 상한을 지킬 수 없다`);
  const fixed = new Array<boolean>(n).fill(false);
  const w = new Array<number>(n).fill(0);
  for (let iter = 0; iter <= n; iter++) {
    const nFixed = fixed.filter(Boolean).length;
    const rest = 1 - cap * nFixed;
    const free = mc.map((x, i) => (fixed[i] ? 0 : x));
    const sum = free.reduce((a, x) => a + x, 0);
    let again = false;
    for (let i = 0; i < n; i++) {
      if (fixed[i]) { w[i] = cap; continue; }
      w[i] = (rest * free[i]) / sum;
      if (w[i] > cap + 1e-15) { fixed[i] = true; again = true; }
    }
    if (!again) return w;
  }
  throw new Error("상한 재배분이 수렴하지 않았다");
}
