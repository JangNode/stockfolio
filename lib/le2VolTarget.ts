// 연구 LV 변동성 목표화 계산(순수 함수). 정의: docs/research/le2-voltarget-prereg.md 3절.

/** 날짜 달력(CAL)에 맞춘 종가 배열: 그날 행이 없으면 직전 행 종가를 이어 쓰고(거래정지·결측), 첫 행 이전은 NaN. */
export function alignCloses(cal: string[], idx: Map<string, number>, close: Float64Array): Float64Array {
  const out = new Float64Array(cal.length).fill(NaN);
  let last = NaN;
  for (let t = 0; t < cal.length; t++) {
    const i = idx.get(cal[t]);
    if (i !== undefined) last = close[i];
    out[t] = last;
  }
  return out;
}

/**
 * 판단일 c(달력 인덱스)까지 직전 window개 거래일 동안 종목들을 동일 비중으로(매일 재조정) 담았다고 가정한 포트폴리오 일수익률의 표본표준편차(n−1) × √annualDays.
 * 일수익률 = 종목별 aligned[t] ÷ aligned[t−1] − 1의 평균. aligned[c−window]부터 값이 있는 종목만 쓰고(그 이전 상장 종목 제외), 쓸 종목이 없거나 c < window이면 NaN.
 */
export function equalWeightSigma(aligned: Float64Array[], c: number, window: number, annualDays: number): number {
  if (c < window || window < 2) return NaN;
  const use = aligned.filter((a) => { for (let t = c - window; t <= c; t++) if (!(a[t] > 0)) return false; return true; });
  if (!use.length) return NaN;
  const r: number[] = [];
  for (let t = c - window + 1; t <= c; t++) { let s = 0; for (const a of use) s += a[t] / a[t - 1] - 1; r.push(s / use.length); }
  const m = r.reduce((x, y) => x + y, 0) / r.length;
  const v = r.reduce((x, y) => x + (y - m) ** 2, 0) / (r.length - 1);
  return Math.sqrt(v) * Math.sqrt(annualDays);
}

/** 목표 배율 = min(1, σ_target ÷ σ)를 소수 dp자리로 반올림. σ를 구할 수 없거나 0이면 1(제한 없음). */
export function volMultiplier(sigma: number, target: number, dp: number): number {
  if (!Number.isFinite(sigma) || !(sigma > 0)) return 1;
  const f = 10 ** dp;
  return Math.round(Math.min(1, target / sigma) * f) / f;
}
