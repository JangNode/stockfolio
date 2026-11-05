// 연구 묶음 1(Q1~Q4, 시도 278~281) 기준값. 사용자 지정 2026-11-05. 사전등록: docs/research/batch1-prereg.md
// 값은 첫 시험 전에 고정했고 결과를 본 뒤 바꾸지 않는다(사전 점검에서 발견한 논리 결함만 사유를 기록하고 고친다).
export const B1_PRIOR_TESTS = 277;
export const B1_TRIALS = { q1: 278, q2: 279, q3: 280, q4: 281 } as const;
/** "K200P" 순위 목록 깊이: 월말 시장 구분 코스피 구성원 중 제외 규칙 적용 뒤 판단일 시총 내림차순 상위 N종목. 이 밖의 순위는 OUT_RANK로 본다. */
export const B1_RANK_DEPTH = 200;
export const B1_OUT_RANK = 201;
/** Q1 업종 = stock_industry_classification.induty_code(DART 업종코드 보완본)의 앞 이 자리수(KSIC 중분류 수준). */
export const B1_IND_PREFIX = 2;
/** Q1 업종 내 후보 시총 순위 범위(리더 = 1위). */
export const B1_Q1_RANK_FROM = 2;
export const B1_Q1_RANK_TO = 6;
/** 각 가설의 기본 파라미터(P0)와 게이트 D 이웃(하나씩만 변경). 키 의미는 docs/research/batch1-prereg.md 1~4절. */
export type B1P = Record<string, number>;
export const B1_Q1_P0: B1P = { lead: 0.08, lagFrac: 0.5, hold: 10, look: 5, slots: 10 };
export const B1_Q1_NB: [string, B1P][] = [["리더 기준 +6%", { lead: 0.06 }], ["리더 기준 +10%", { lead: 0.1 }], ["보유 5거래일", { hold: 5 }], ["보유 15거래일", { hold: 15 }], ["후보 기준 리더의 0.3배", { lagFrac: 0.3 }], ["후보 기준 리더의 0.7배", { lagFrac: 0.7 }]];
export const B1_Q2_P0: B1P = { rise: 15, look: 60, dropExit: 10, maxHold: 60, slots: 10 };
export const B1_Q2_NB: [string, B1P][] = [["상승폭 기준 10위", { rise: 10 }], ["상승폭 기준 20위", { rise: 20 }], ["비교 창 40거래일", { look: 40 }], ["비교 창 90거래일", { look: 90 }], ["청산 하락폭 5위", { dropExit: 5 }], ["청산 하락폭 15위", { dropExit: 15 }]];
export const B1_Q3_P0: B1P = { top: 50, drop: -0.1, ma: 120, hold: 10, take: 0.05, look: 5, slots: 10 };
export const B1_Q3_NB: [string, B1P][] = [["낙폭 기준 −7%", { drop: -0.07 }], ["낙폭 기준 −13%", { drop: -0.13 }], ["익절 +4%", { take: 0.04 }], ["익절 +6%", { take: 0.06 }], ["보유 7거래일", { hold: 7 }], ["보유 15거래일", { hold: 15 }], ["대상 시총 상위 30", { top: 30 }], ["대상 시총 상위 100", { top: 100 }]];
export const B1_Q4_P0: B1P = { thr: -0.03, top: 20, hold: 5 };
export const B1_Q4_NB: [string, B1P][] = [["임계 −2%", { thr: -0.02 }], ["임계 −4%", { thr: -0.04 }], ["종목 수 10", { top: 10 }], ["종목 수 30", { top: 30 }], ["보유 3거래일", { hold: 3 }], ["보유 10거래일", { hold: 10 }]];
/** 게이트 F 참고선: 1 − 0.05 ÷ (이번 묶음의 시험 수). */
export const B1_F_DENOMINATOR = 4;
/** 보고용 DS6 기록(연속 전체 CAGR / MDD, 연 회전율 %, 비용 합계 %)과 연도별 수익률 %(2011은 01-04부터, 2026은 10-26까지). */
export const B1_DS6_REC = { 전체: [11.7, 39.15], 구간1: [4.11, 24.51], 구간2: [9.17, 30.78], 구간3: [22.54, 33.66], turnover: 303.95, cost: 20.7 } as const;
export const B1_DS6_YEARLY: Record<string, number> = { 2011: 2.13, 2012: 6.63, 2013: -2.09, 2014: 6.47, 2015: 0.45, 2016: 11.58, 2017: 36.24, 2018: -21.83, 2019: 16.6, 2020: 38.91, 2021: -1.57, 2022: -27.47, 2023: 34.81, 2024: -6.89, 2025: 98.02, 2026: 47.62 };
