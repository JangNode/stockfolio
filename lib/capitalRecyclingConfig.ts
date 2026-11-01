// 연구 CAPREC(자본 재활용 배분 Q1 = 시도 257, Q2 = 258, Q3 = 259) 기준값. 사용자 지정 2026-11-01. 사전등록: docs/research/capital-recycling-prereg.md
// 구성요소(PE4·W3·LV1·L3)는 연구 ALLOC(lib/strategyAllocationConfig.ts)와 같은 코드·같은 순수익이다. PE4 비중 W와 코어 구성은 시험 전에 고정했고 결과를 본 뒤 바꾸지 않는다.
export const CAPREC_PRIOR_TESTS = 256;
/** 연구 ALLOC P1~P3 보고 표에 기록된 구성요소의 공통 평가 구간(2017-04-04~ 자른) 전체 CAGR / MDD. 소수 둘째 자리까지 같아야 한다. 다르면 중단한다. */
export const CAPREC_COMP_CUT_REF = {
  PE4: { cagr: 14.21, mdd: 23.99 },
  W3: { cagr: 3.48, mdd: 47.04 },
  LV1: { cagr: 9.57, mdd: 46.46 },
  L3: { cagr: 20.66, mdd: 51.63 },
} as const;
/** 게이트 H 참고선과 재현 확인: 연구 ALLOC의 P2(PE4·W3·LV1·L3 각 1/4, 매일 재배분, 이동 금액의 0.25%) 전체 CAGR / MDD. 같은 코드로 다시 계산해 일치를 확인한다. */
export const CAPREC_P2_REF = { cagr: 13.08, mdd: 29.84 } as const;
/** 이동 금액(PE4 ↔ 코어 이동 + 코어 안 균등 되돌림)에 한 번 적용하는 비율. 편도 평균 비용+슬리피지 가정(사용자 지정). 모든 슬리브에서 같은 비율로 차감한다. */
export const CAPREC_MOVE_COST = 0.0025;
/** 정보용(판정 불사용): 매도·매수 양쪽에 각각 적용하는 보수적 해석. */
export const CAPREC_MOVE_COST_SENS = 0.005;
/** 게이트 F 참고선: 1 − 0.05 ÷ (이번 사전등록의 후보 수). */
export const CAPREC_F_DENOMINATOR = 3;
/** 게이트 D: PE4 비중 W를 ±이만큼 바꾼 변형(사용자 지정 ±1/6). */
export const CAPREC_W_NEIGHBOR = 1 / 6;
/** 투입 비율 f_t 분포 보고용 분위. */
export const CAPREC_F_QUANTILES = [0.05, 0.25, 0.5, 0.75, 0.95] as const;
/** 후보: W = PE4 비중(PE4 계좌 자본 중 실제 보유 비중 f_t × W만 PE4에 투입), core = 코어 구성요소(균등). */
export const CAPREC_CANDS = {
  Q1: { trial: 257, w: 1 / 3, core: ["W3", "LV1", "L3"] },
  Q2: { trial: 258, w: 1 / 2, core: ["W3", "LV1", "L3"] },
  Q3: { trial: 259, w: 1 / 3, core: ["W3", "LV1"] },
} as const;
export type CaprecCompId = "PE4" | "W3" | "LV1" | "L3";
/** PE4 분해 파일(PE4_split.json: 날짜, f, rHold, costFrac, ret)의 SHA-256. 사전 점검 실행(run 41359098160)이 기록한 값이며, 시험 실행은 같은 값이어야 한다. */
export const CAPREC_PE4_SPLIT_SHA = "8a24d4281415b6e14489b2419c2e9288dd9d8c29d2e3cdedcdb1dbf693c72ea4";
