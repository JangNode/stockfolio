// 연구 DS5(시도 270)·DS6(시도 271) 기준값. 사용자 지정 2026-11-03. 사전등록: docs/research/ds5-prereg.md
// 공시(DART) 데이터를 쓰지 않는 DS4 변형: DS5 = DS4에서 PE4만 제거, DS6 = 위성을 LV1 단독으로. 코어·합성·비용·교체 확인 일수는 연구 DS4와 같고, 값은 시험 전에 고정했으며 결과를 본 뒤 바꾸지 않는다.
// 코어 정의 상수(CS_SWAP_CONFIRM_DAYS, CS_RANK_DEPTH)·합성 이동 비용(CS_MOVE_COST)·코어 비중 이웃 폭(CS_CORE_W_NEIGHBOR)·변동성 창(IVA_VOL_WINDOW)은 연구 CS·IVA의 상수를 그대로 쓴다.
export const DS56_PRIOR_TESTS = 269;
/** DS5 게이트 D 위성 구성 이웃: 한쪽 구성요소 비중 상한(해당 구성요소가 이 값을 넘으면 자르고 초과분은 나머지에 비례). 사용자 지정 "한쪽 비중 상한 지정"을 W3 상한·LV1 상한 각각으로 해석했다. */
export const DS5_SIDE_CAP = 0.6;
/** 후보: coreW = 코어 비중, coreN = 코어 종목 수, sat = 위성 구성요소(변동성 역수 배분 대상), nNeighbors = 게이트 D 코어 종목 수 변형,
 * fixedEqNb = 위성 W3:LV1 반반 고정 이웃 여부, sideCapNb = 한쪽 비중 상한 이웃 대상(상한값 DS5_SIDE_CAP), winNb = 변동성 창 이웃(DS6). */
export const DS56_CANDS = {
  DS5: { trial: 270, coreW: 0.4, coreN: 2, sat: ["W3", "LV1"], nNeighbors: [1, 3], fixedEqNb: true, sideCapNb: ["W3", "LV1"], winNb: [] },
  DS6: { trial: 271, coreW: 0.4, coreN: 2, sat: ["LV1"], nNeighbors: [1, 3], fixedEqNb: false, sideCapNb: [], winNb: [120, 500] },
} as const;
/** 참고 열: 연구 DS4(코어 40% + PE4 20% 상한 위성)의 평가 구간 전체 CAGR / MDD. 소수 둘째 자리까지 같아야 한다. */
export const DS56_DS4_REF = { cagr: 15.2, mdd: 33.11 } as const;
