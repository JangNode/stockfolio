// 52주 신고가 근접 시험 HM1(323)·HM1C(324) 기준값. 사용자 지정 2026-11-25. 사전등록: docs/research/high52-prereg.md (첫 시험 전 커밋).
// 값은 첫 시험 전에 고정했고 결과를 보고 바꾸지 않는다(구현의 논리 결함만 사유를 기록하고 고친다).
export const H_FIRST_TRIAL = 323;
export const H_PRIOR_TESTS = 322;
/** 게이트 F 참고선: 1 − 0.05 ÷ (이번 사전등록의 후보 수 2). 판정 기준 자체(백분위 ≥ 95)는 바뀌지 않는다. */
export const H_F_DENOMINATOR = 2;
/** n: 보유 종목 수, keepMult: 기존 보유 유지 순위 = n × keepMult, lookback: 직전 최고 종가를 보는 거래일 수(당일 제외), minValidFrac: 그 기간 중 종가 행이 있어야 하는 최소 비율. */
export interface HmP { n: number; keepMult: number; lookback: number; minValidFrac: number }
export const HM1_P0: HmP = { n: 20, keepMult: 2, lookback: 252, minValidFrac: 0.8 };
/** 게이트 D 이웃값(사용자 지정 정의에서 한 번에 한 값만 바꾼다): 종목 수 15·30(유지 순위는 항상 2배), 룩백 189·315거래일(±25%). */
export const HM1_NB: [string, Partial<HmP>][] = [["종목 수 15", { n: 15 }], ["종목 수 30", { n: 30 }], ["룩백 189거래일", { lookback: 189 }], ["룩백 315거래일", { lookback: 315 }]];
