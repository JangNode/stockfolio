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
/** 참고 열(재계산하지 않고 연구 기록값을 그대로 표시한다 — PE4가 들어간 계열을 다시 돌리면 공시 부분집합 캐시를 읽어야 하므로): CAGR / MDD, 키 = 학습·확인·보류·전체·2026년 제외. 출처: research/core-satellite-prereg.md(CS2), delay-robust-core-satellite-prereg.md(DS2), ds4-prereg.md(DS4). */
export const DS56_RECORDED = {
  CS2: { 학습: [8.71, 19.83], 확인: [21.94, 21.76], 보류: [18.44, 31.01], 전체: [16.26, 31.01], ex26: [12.79, 27.17] },
  DS2: { 학습: [5.65, 27.08], 확인: [15.01, 29.82], 보류: [19.22, 35.66], 전체: [14.28, 35.66], ex26: [10.28, 33.23] },
  DS4: { 학습: [6.99, 23.91], 확인: [17.93, 26.77], 보류: [19.0, 33.11], 전체: [15.2, 33.11], ex26: [11.44, 30.28] },
  /** 연도별 수익률 %, 2017(04-04부터)~2026(10-26까지). */
  yearly: {
    CS2: [18.74, -11.2, 19.22, 35.5, 9.71, -21.83, 18.52, -10.48, 84.82, 47.4],
    DS4: [18.74, -15.55, 20.0, 31.2, 5.98, -22.36, 20.03, -11.09, 85.93, 50.04],
  },
} as const;
