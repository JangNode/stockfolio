/**
 * [임시 연구 — 병합 금지] 연구 MV1 최소분산 결정적 풀이(순수 함수).
 * minimize w'Σw  s.t. Σw = 1, 0 ≤ w ≤ cap. 가속 투영 경사법(FISTA) + 상자·합 제약 집합(capped simplex)으로의 정확한 투영(이분법). 시작점은 균등 비중(또는 지정).
 * 수렴 조건: KKT 최대 위반(kktViolation) < tol. 미수렴이면 호출자가 중단한다.
 */
/** v를 {0 ≤ w ≤ cap, Σw = 1}로 투영: w_i = clip(v_i − λ, 0, cap), Σw = 1이 되는 λ를 이분법으로 찾는다(80회, 구간 폭 < 1e-23). */
export function projectCappedSimplex(v: Float64Array, cap: number, out: Float64Array): void {
  const n = v.length;
  let lo = Number.POSITIVE_INFINITY, hi = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < n; i++) { if (v[i] < lo) lo = v[i]; if (v[i] > hi) hi = v[i]; }
  lo -= cap + 1; hi += 1;
  const sum = (lam: number): number => { let s = 0; for (let i = 0; i < n; i++) { const x = v[i] - lam; s += x < 0 ? 0 : x > cap ? cap : x; } return s; };
  for (let it = 0; it < 80; it++) { const mid = (lo + hi) / 2; if (sum(mid) > 1) lo = mid; else hi = mid; }
  const lam = (lo + hi) / 2;
  for (let i = 0; i < n; i++) { const x = v[i] - lam; out[i] = x < 0 ? 0 : x > cap ? cap : x; }
}
/** KKT 최대 위반: g = 2Σw. 자유 변수(0<w<cap)는 g가 모두 같아야 하고, 하한(w=0) 변수는 g ≥ λ, 상한(w=cap) 변수는 g ≤ λ. λ = 자유 변수 g 평균(없으면 하한·상한 사이 중간). 반환 = 위반 크기의 최댓값. */
export function kktViolation(S: Float64Array, n: number, w: Float64Array, cap: number): number {
  const g = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = 0; const r = i * n; for (let j = 0; j < n; j++) s += S[r + j] * w[j]; g[i] = 2 * s; }
  const eps = 1e-12;
  let lamSum = 0, nFree = 0, gLowMax = Number.NEGATIVE_INFINITY, gUpMin = Number.POSITIVE_INFINITY;
  for (let i = 0; i < n; i++) {
    if (w[i] > eps && w[i] < cap - eps) { lamSum += g[i]; nFree++; }
    else if (w[i] <= eps) { if (g[i] < gUpMin) gUpMin = g[i]; }
    else if (g[i] > gLowMax) gLowMax = g[i];
  }
  const lam = nFree ? lamSum / nFree : (Math.max(gLowMax, Number.NEGATIVE_INFINITY) + Math.min(gUpMin, Number.POSITIVE_INFINITY)) / 2;
  let viol = 0;
  for (let i = 0; i < n; i++) {
    if (w[i] > eps && w[i] < cap - eps) viol = Math.max(viol, Math.abs(g[i] - lam));
    else if (w[i] <= eps) viol = Math.max(viol, lam - g[i]);
    else viol = Math.max(viol, g[i] - lam);
  }
  return viol;
}
export interface MvSolve { w: Float64Array; iters: number; kkt: number; obj: number }
export function solveMinVar(S: Float64Array, n: number, cap: number, tol: number, maxIter: number, start?: Float64Array): MvSolve {
  if (n * cap < 1 - 1e-12) throw new Error(`종목 수 ${n} × 상한 ${cap} < 1 — 합 1을 채울 수 없다`);
  // 보폭 1/L, L = 2 × (Σ의 최대 고유값 상한 = 최대 행 절댓값 합)
  let rowMax = 0;
  for (let i = 0; i < n; i++) { let s = 0; for (let j = 0; j < n; j++) s += Math.abs(S[i * n + j]); if (s > rowMax) rowMax = s; }
  const L = 2 * rowMax, step = 1 / L;
  let x = start ? Float64Array.from(start) : new Float64Array(n).fill(1 / n);
  const y = Float64Array.from(x), xn = new Float64Array(n), v = new Float64Array(n), g = new Float64Array(n);
  let t = 1, it = 0, kkt = Number.POSITIVE_INFINITY;
  const objOf = (w: Float64Array): number => { let s = 0; for (let i = 0; i < n; i++) { let r = 0; for (let j = 0; j < n; j++) r += S[i * n + j] * w[j]; s += w[i] * r; } return s; };
  for (; it < maxIter; it++) {
    for (let i = 0; i < n; i++) { let s = 0; const r = i * n; for (let j = 0; j < n; j++) s += S[r + j] * y[j]; g[i] = 2 * s; v[i] = y[i] - step * g[i]; }
    projectCappedSimplex(v, cap, xn);
    const tn = (1 + Math.sqrt(1 + 4 * t * t)) / 2, mom = (t - 1) / tn;
    // 기울기 기반 재시작(O'Donoghue–Candès): 진행 방향과 모멘텀 방향이 어긋나면 모멘텀을 버린다.
    let dot = 0;
    for (let i = 0; i < n; i++) dot += (y[i] - xn[i]) * (xn[i] - x[i]);
    if (dot > 0) { for (let i = 0; i < n; i++) y[i] = xn[i]; t = 1; }
    else { for (let i = 0; i < n; i++) y[i] = xn[i] + mom * (xn[i] - x[i]); t = tn; }
    x = Float64Array.from(xn);
    if (it % 25 === 24 || it === maxIter - 1) { kkt = kktViolation(S, n, x, cap); if (kkt < tol) { it++; break; } }
  }
  return { w: x, iters: it, kkt, obj: objOf(x) };
}
