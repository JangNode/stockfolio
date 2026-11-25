// 시총 상위 5종목 집중 시험 TC1(325)·TC2(326) 기준값. 사용자 지정 2026-11-26. 사전등록: docs/research/megacap-prereg.md (첫 시험 전 커밋).
// 값은 첫 시험 전에 고정했고 결과를 보고 바꾸지 않는다(구현의 논리 결함만 사유를 기록하고 고친다).
export const M_FIRST_TRIAL = 325;
export const M_PRIOR_TESTS = 324;
/** 게이트 F 참고선: 1 − 0.05 ÷ (이번 사전등록의 후보 수 2). 판정 기준 자체(백분위 ≥ 95)는 바뀌지 않는다. */
export const M_F_DENOMINATOR = 2;
/** n: 시총 상위 종목 수(동일 비중 1/n), ma: 이동평균 거래일 수(0이면 이동평균 조건 없음), minValidFrac: 이동평균 기간 중 종가 행이 있어야 하는 최소 비율. */
export interface TcP { n: number; ma: number; minValidFrac: number }
export const TC1_P0: TcP = { n: 5, ma: 0, minValidFrac: 0.8 };
export const TC2_P0: TcP = { n: 5, ma: 200, minValidFrac: 0.8 };
/** 게이트 D 이웃값(사용자 지정): TC1 상위 3종목·상위 10종목, TC2 이동평균 150일·250일. */
export const TC1_NB: [string, Partial<TcP>][] = [["상위 3종목", { n: 3 }], ["상위 10종목", { n: 10 }]];
export const TC2_NB: [string, Partial<TcP>][] = [["이동평균 150일", { ma: 150 }], ["이동평균 250일", { ma: 250 }]];
/** 비교 기준 "K200P 시총 비중"(RT0, 종목당 상한 30%, 월말 재조정, 앞선 RT 시험): 사용자 지정 참고값 연속 CAGR / MDD(%), 사전 점검에서 재현을 확인한다. */
export const M_REF_CAPW = { cagr: 6.07, mdd: 43.99 } as const;
