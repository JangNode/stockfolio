// 연구 DS4(코어 40% + PE4 20% 상한 위성, 시도 269) 기준값. 사용자 지정 2026-11-03. 사전등록: docs/research/ds4-prereg.md
// 정의는 연구 DS3과 같고 코어 비중만 40%다(DS2의 코어 40%와 DS3의 PE4 위성 상한 20% 사이의 한 점). 값은 시험 전에 고정했고 결과를 본 뒤 바꾸지 않는다.
// 코어 정의 상수(CS_SWAP_CONFIRM_DAYS, CS_RANK_DEPTH)·합성 이동 비용(CS_MOVE_COST)·코어 비중 이웃 폭(CS_CORE_W_NEIGHBOR)·변동성 창(IVA_VOL_WINDOW)·PE4 상한 규칙(capRedistribute)은 연구 CS·IVA·DS의 상수를 그대로 쓴다.
export const DS4_PRIOR_TESTS = 268;
/** 후보: coreW = 코어 비중, coreN = 코어 종목 수, sat = 위성 구성요소, pe4Cap = 위성 안 PE4 비중 상한, nNeighbors = 게이트 D 코어 종목 수 변형, capNeighbors = 게이트 D PE4 상한 변형. */
export const DS4_CAND = { trial: 269, coreW: 0.4, coreN: 2, sat: ["PE4", "W3", "LV1"], pe4Cap: 0.2, nNeighbors: [1, 3], capNeighbors: [0.1, 0.3] } as const;
/** 재현 기준(연구 DS 보고 표, 평가 구간 전체 CAGR / MDD). 소수 둘째 자리까지 같아야 한다. 다르면 중단한다. */
export const DS4_REF = { DS2: { cagr: 14.28, mdd: 35.66 }, DS3: { cagr: 13.72, mdd: 30.34 } } as const;
/** 1페이지 요약 표용: 연구 DS 시험 기록의 게이트 O/X (A, B, C, D, E, F, G, H). */
export const DS4_REF_GATES = {
  DS2: { A: true, B: false, C: true, D: true, E: true, F: true, G: true, H: true },
  DS3: { A: false, B: true, C: true, D: false, E: false, F: true, G: true, H: true },
} as const;
