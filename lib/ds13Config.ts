// 연구 DS13(코어 + 잔차 모멘텀·저위험 혼합 위성, 시험 309 DS13M · 310 DS13L) 기준값. 사용자 지정 2026-11-17. 사전등록: docs/research/ds13-prereg.md (74838e1, 첫 시험 전 커밋).
// 값은 첫 시험 전에 고정했고 결과를 보고 바꾸지 않는다(구현의 논리 결함만 사유를 기록하고 고친다).
export type Alloc3 = [number, number, number];
/** 코어 / 모멘텀 위성(RM1) / 저위험 위성(MV1 또는 LV1) 초기·목표 비중. */
export const DS13_W: Alloc3 = [0.4, 0.3, 0.3];
/** D 이웃값: 위성 배분(모멘텀/저위험) 20/40·40/20, 코어 비중 30%·50%(위성은 비례 조정). RM1 종목 수 15·25는 `B5_RM_NB`의 종목 수 이웃을 쓴다. */
export const DS13_NB_W: [string, Alloc3][] = [["위성 배분 20/40 (모멘텀/저위험)", [0.4, 0.2, 0.4]], ["위성 배분 40/20", [0.4, 0.4, 0.2]], ["코어 비중 30% (위성 비례)", [0.3, 0.35, 0.35]], ["코어 비중 50% (위성 비례)", [0.5, 0.25, 0.25]]];
export const DS13_NB_RM_N = [15, 25] as const;
/** 시험 번호 시작(309 = DS13M, 310 = DS13L)과 DS13 이전 누적 시험 수. */
export const DS13_FIRST_TRIAL = 309;
export const DS13_PRIOR_TESTS = 308;
/** 구간 2 상세 보고용 창. */
export const DS13_WIN2 = { from: "2017-04-04", to: "2021-12-31" } as const;
/** 두 종목(삼성전자·SK하이닉스) 정보용 보고 대상. */
export const DS13_WATCH = ["005930", "000660"] as const;
