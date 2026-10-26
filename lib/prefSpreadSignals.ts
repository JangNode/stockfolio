/**
 * [임시 연구 — 병합 금지] 연구 A(우선주 괴리 회귀) 신호 계산(순수 함수, I/O 없음). 정의: docs/research/a-pref-spread-prereg.md 구현 정의 4·5.
 * 모든 배열은 거래일 달력(CAL) 인덱스에 맞춘 길이 nCal의 배열이다.
 */

/** 날 t에 두 종목이 모두 체결(수정 종가 > 0, 거래량 > 0)된 날만 s_t = ln(우선주 수정 종가 / 보통주 수정 종가). 그 외 NaN. */
export function pairSpread(pClose: Float64Array, cClose: Float64Array, pVol: Float64Array, cVol: Float64Array): Float64Array {
  const n = pClose.length, s = new Float64Array(n).fill(NaN);
  for (let c = 0; c < n; c++) if (pVol[c] > 0 && cVol[c] > 0 && pClose[c] > 0 && cClose[c] > 0) s[c] = Math.log(pClose[c] / cClose[c]);
  return s;
}

/** 직전 W거래일(당일 제외) 안의 s 평균·표본 표준편차(n−1)로 z = (s_t − 평균) / 표준편차. 창 안 s가 ⌈minObsRatio·W⌉개 미만이거나 표준편차가 0이면 NaN. */
export function rollingZ(s: Float64Array, W: number, minObsRatio: number): Float64Array {
  const n = s.length, z = new Float64Array(n).fill(NaN);
  let m0 = 0, n0 = 0;
  for (let c = 0; c < n; c++) if (Number.isFinite(s[c])) { m0 += s[c]; n0++; }
  m0 = n0 ? m0 / n0 : 0;
  const cs = new Float64Array(n + 1), cs2 = new Float64Array(n + 1), cc = new Float64Array(n + 1);
  for (let c = 0; c < n; c++) {
    const ok = Number.isFinite(s[c]), v = ok ? s[c] - m0 : 0;
    cs[c + 1] = cs[c] + v; cs2[c + 1] = cs2[c] + v * v; cc[c + 1] = cc[c] + (ok ? 1 : 0);
  }
  const minObs = Math.max(Math.ceil(minObsRatio * W), 3);
  for (let c = W; c < n; c++) {
    if (!Number.isFinite(s[c])) continue;
    const m = cc[c] - cc[c - W];
    if (m < minObs) continue;
    const sum = cs[c] - cs[c - W], sum2 = cs2[c] - cs2[c - W];
    const mean = sum / m, varr = (sum2 - (sum * sum) / m) / (m - 1);
    if (!(varr > 1e-12)) continue;
    z[c] = (s[c] - m0 - mean) / Math.sqrt(varr);
  }
  return z;
}

/** 직전 window거래일(당일 제외) 중 s가 없는 날의 비율이 maxRatio 이하인 날 1, 아니면 0. */
export function noTradeOk(s: Float64Array, window: number, maxRatio: number): Uint8Array {
  const n = s.length, ok = new Uint8Array(n), cc = new Float64Array(n + 1);
  for (let c = 0; c < n; c++) cc[c + 1] = cc[c] + (Number.isFinite(s[c]) ? 1 : 0);
  for (let c = window; c < n; c++) ok[c] = 1 - (cc[c] - cc[c - window]) / window <= maxRatio ? 1 : 0;
  return ok;
}
