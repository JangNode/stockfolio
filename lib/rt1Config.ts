// 연구 RT1·RT1F·RT2(시가총액 비중 + 잔차 모멘텀 기울기, 시험 306~308) 기준값. 사용자 지정 2026-11-17. 사전등록: docs/research/rt1-prereg.md (첫 시험 전 커밋 acb4f24).
// 값은 첫 시험 전에 고정했고 결과를 보고 바꾸지 않는다(구현의 논리 결함만 사유를 기록하고 고친다).
export interface RtP { share: number; keepOff: number; cap: number; start: number; skip: number; minValid: number }
/** 점수(069500 회귀 잔차 모멘텀)는 RM1과 같다: 창 t−252~t−21, 유효 200일 이상(`lib/batch5Config.ts`의 B5_RM_P0와 같은 값). */
const RT_SCORE = { start: 252, skip: 21, minValid: 200 } as const;
/** RT1·RT1F: 점수 상위 50% 시총 비중, 기존 보유는 상위 60% 안이면 유지(유지 여유 = 선정 비율 + 0.10), 종목당 상한 30%. */
export const RT1_P0: RtP = { share: 0.5, keepOff: 0.1, cap: 0.3, ...RT_SCORE };
/** RT2: 점수 상위 25%, 유지 35%. 나머지는 RT1과 같다. */
export const RT2_P0: RtP = { share: 0.25, keepOff: 0.1, cap: 0.3, ...RT_SCORE };
/** D 이웃값(한 번에 하나씩): 선정 비율(유지 기준은 비율 + keepOff로 함께 이동), 건너뛰는 최근 구간 10·42일, 종목당 상한 25%·35%. */
export const RT1_NB: [string, Partial<RtP>][] = [["보유 기준 40%", { share: 0.4 }], ["보유 기준 60%", { share: 0.6 }], ["건너뛰는 구간 10일", { skip: 10 }], ["건너뛰는 구간 42일", { skip: 42 }], ["종목당 상한 25%", { cap: 0.25 }], ["종목당 상한 35%", { cap: 0.35 }]];
export const RT2_NB: [string, Partial<RtP>][] = [["보유 기준 20%", { share: 0.2 }], ["보유 기준 30%", { share: 0.3 }], ["건너뛰는 구간 10일", { skip: 10 }], ["건너뛰는 구간 42일", { skip: 42 }], ["종목당 상한 25%", { cap: 0.25 }], ["종목당 상한 35%", { cap: 0.35 }]];
/** 기준선 RT0(K200P 시총 비중 전체)의 연속 CAGR이 069500과 이 값(%p)을 넘게 다르면 시험을 시작하지 않고 원인을 보고한다. */
export const RT_BASELINE_MAX_GAP_PP = 1.5;
/** 시험 번호 시작(306 = RT1, 307 = RT1F, 308 = RT2). */
export const RT_FIRST_TRIAL = 306;
/** 정보용 보고 대상 종목(삼성전자·SK하이닉스). */
export const RT_WATCH = ["005930", "000660"] as const;
/** 상위 N종목 비중 합 보고(정보용). */
export const RT_TOP_N_WEIGHT = 5;
