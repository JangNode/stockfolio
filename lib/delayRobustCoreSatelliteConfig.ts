// 연구 DS(지연 둔감 코어-위성 DS1 = 시도 266, DS2 = 267, DS3 = 268) 기준값. 사용자 지정 2026-11-03. 사전등록: docs/research/delay-robust-core-satellite-prereg.md
// 코어는 연구 CS와 같은 규칙(월말 K200P 구성 안 당일 시총 상위 N종목, 시총 비율, 순위 밖 5거래일 연속일 때만 교체)이고, 위성은 PE4를 빼거나 PE4 비중에 상한을 둔 변동성 역수 배분이다. 값은 시험 전에 고정했고 결과를 본 뒤 바꾸지 않는다.
// 코어 정의 상수(CS_SWAP_CONFIRM_DAYS, CS_RANK_DEPTH)·합성 이동 비용(CS_MOVE_COST)·코어 비중 이웃 폭(CS_CORE_W_NEIGHBOR)·변동성 창(IVA_VOL_WINDOW)은 연구 CS·IVA의 상수를 그대로 쓴다.
export const DS_PRIOR_TESTS = 265;
/** 게이트 F 참고선: 1 − 0.05 ÷ (이번 사전등록의 후보 수). */
export const DS_F_DENOMINATOR = 3;
/** 후보: coreW = 코어 비중(나머지는 위성), coreN = 코어 종목 수, sat = 위성 구성요소(변동성 역수 배분 대상), pe4Cap = 위성 안 PE4 비중 상한(없으면 null, 초과분은 나머지에 변동성 역수 비중 비례로 배분),
 * nNeighbors = 게이트 D의 코어 종목 수 변형, capNeighbors = 게이트 D의 PE4 상한 변형. */
export const DS_CANDS = {
  DS1: { trial: 266, coreW: 0.3, coreN: 2, sat: ["W3", "LV1"], pe4Cap: null, nNeighbors: [1, 3], capNeighbors: [] },
  DS2: { trial: 267, coreW: 0.4, coreN: 2, sat: ["W3", "LV1"], pe4Cap: null, nNeighbors: [1, 3], capNeighbors: [] },
  DS3: { trial: 268, coreW: 0.3, coreN: 2, sat: ["PE4", "W3", "LV1"], pe4Cap: 0.2, nNeighbors: [1, 3], capNeighbors: [0.1, 0.3] },
} as const;
/** 재현 기준(연구 CS·IVA 보고 표, 평가 구간 전체 CAGR / MDD). 소수 둘째 자리까지 같아야 한다. 다르면 중단한다. */
export const DS_REF = {
  CS1: { cagr: 14.94, mdd: 27.81 },
  CS2: { cagr: 16.26, mdd: 31.01 },
  R3: { cagr: 10.61, mdd: 27.03 },
} as const;
/** 비중 상한 적용: 비중 w_j가 상한 v를 넘으면 w_j = v로 자르고 초과분 w_j − v를 나머지 구성요소에 그 구성요소의 (상한 적용 전) 변동성 역수 비중에 비례해 더한다. */
export const capRedistribute = (w: readonly number[], j: number, v: number): number[] => {
  if (!(w[j] > v)) return w.slice();
  const excess = w[j] - v, others = w.reduce((a, x, k) => (k === j ? a : a + x), 0);
  return w.map((x, k) => (k === j ? v : x + (others > 0 ? (excess * x) / others : 0)));
};
