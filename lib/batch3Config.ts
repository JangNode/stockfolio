// 연구 묶음 3(S1~S4, 시도 287~290) 기준값. 사용자 지정 2026-11-09. 사전등록: docs/research/batch3-prereg.md
// 값은 첫 시험 전에 고정했고 결과를 본 뒤 바꾸지 않는다(사전 점검에서 발견한 논리 결함만 사유를 기록하고 고친다).
export const B3_PRIOR_TESTS = 286;
export const B3_TRIALS = { s1: 287, s2: 288, s3: 289, s4: 290 } as const;
/** "K200P" 순위 목록 깊이(묶음 1·2와 같음): 월말 시장 구분 코스피 구성원 중 제외 규칙 적용 뒤 판단일 시총 내림차순 상위 N종목. */
export const B3_RANK_DEPTH = 200;
/** 각 가설의 기본 파라미터(P0)와 게이트 D 이웃(하나씩만 변경). 키 의미는 docs/research/batch3-prereg.md 1~4절. */
export type B3P = Record<string, number>;
/** S1: bbN = 볼린저 창(중심선 = bbN일 단순이동평균), bbK = 밴드 폭(σ 배수), rsiMax = RSI(14) 상한, trend = 추세선(단순이동평균) 일수, hold = 보유 상한(체결일부터 거래일). */
export const B3_S1_P0: B3P = { bbN: 20, bbK: 2, rsiMax: 35, trend: 120, hold: 10, slots: 10 };
export const B3_S1_NB: [string, B3P][] = [["RSI ≤ 30", { rsiMax: 30 }], ["RSI ≤ 40", { rsiMax: 40 }], ["볼린저 1.5σ", { bbK: 1.5 }], ["볼린저 2.5σ", { bbK: 2.5 }], ["볼린저 창 15일", { bbN: 15 }], ["볼린저 창 25일", { bbN: 25 }], ["추세선 100일", { trend: 100 }], ["추세선 150일", { trend: 150 }], ["보유 상한 5거래일", { hold: 5 }], ["보유 상한 15거래일", { hold: 15 }]];
/** S2: win = 밴드폭 백분위 창, pct = 수축 기준(하위 비율), back = 수축일을 찾는 직전 거래일 수, ma1·ma2 = 추세선(ma1 > ma2 조건), exitMa = 청산 이동평균. 볼린저 창·폭은 S1과 같은 키. */
export const B3_S2_P0: B3P = { bbN: 20, bbK: 2, win: 120, pct: 0.2, back: 10, ma1: 60, ma2: 120, exitMa: 20, slots: 10 };
export const B3_S2_NB: [string, B3P][] = [["수축 하위 10%", { pct: 0.1 }], ["수축 하위 30%", { pct: 0.3 }], ["백분위 창 60일", { win: 60 }], ["백분위 창 250일", { win: 250 }], ["수축일 탐색 직전 5일", { back: 5 }], ["수축일 탐색 직전 20일", { back: 20 }], ["볼린저 1.5σ", { bbK: 1.5 }], ["볼린저 2.5σ", { bbK: 2.5 }], ["청산 이평 10일", { exitMa: 10 }], ["청산 이평 30일", { exitMa: 30 }]];
/** S3: S1과 같고 vk = 전일 VKOSPI 종가 하한이 추가된다. */
export const B3_S3_P0: B3P = { ...B3_S1_P0, vk: 25 };
export const B3_S3_NB: [string, B3P][] = [["VKOSPI ≥ 22", { vk: 22 }], ["VKOSPI ≥ 28", { vk: 28 }], ["RSI ≤ 30", { rsiMax: 30 }], ["RSI ≤ 40", { rsiMax: 40 }], ["볼린저 1.5σ", { bbK: 1.5 }], ["볼린저 2.5σ", { bbK: 2.5 }], ["보유 상한 5거래일", { hold: 5 }], ["보유 상한 15거래일", { hold: 15 }]];
/** S4: adxMin = 진입 ADX(14) 하한, hi = 신고가 기준(직전 hi거래일 종가 최댓값 돌파), ma1·ma2 = 추세선, exitMa = 청산 이동평균, adxExit = ADX 청산 기준(미만이면 청산). */
export const B3_S4_P0: B3P = { adxN: 14, adxMin: 25, hi: 20, ma1: 60, ma2: 120, exitMa: 20, adxExit: 20, slots: 10 };
export const B3_S4_NB: [string, B3P][] = [["ADX 하한 20", { adxMin: 20 }], ["ADX 하한 30", { adxMin: 30 }], ["신고가 기준 10일", { hi: 10 }], ["신고가 기준 55일", { hi: 55 }], ["청산 이평 10일", { exitMa: 10 }], ["청산 이평 30일", { exitMa: 30 }], ["ADX 청산 기준 15", { adxExit: 15 }], ["ADX 청산 기준 25", { adxExit: 25 }]];
/** RSI·ADX 평활 기간(Wilder). S1·S3 RSI = 14, S4 ADX = B3_S4_P0.adxN. */
export const B3_RSI_N = 14;
/** 승률·손익 보고용: 진입 후 전방 수익률 거래일 수(5·10·20). */
export const B3_FWD_DAYS = [5, 10, 20] as const;
/** 게이트 F 참고선: 1 − 0.05 ÷ (이번 묶음의 시험 수). */
export const B3_F_DENOMINATOR = 4;
/** 사전 고지용 누적 시험 수(이번 묶음 마지막 번호). */
export const B3_CUM_TRIALS = 290;
/** 보고용 DS6 기록(연속 전체 CAGR / MDD, 연 회전율 %, 비용 합계 %)과 연도별 수익률 %. 묶음 1·2와 같은 값. */
export const B3_DS6_REC = { 전체: [11.7, 39.15], 구간1: [4.11, 24.51], 구간2: [9.17, 30.78], 구간3: [22.54, 33.66], turnover: 303.95, cost: 20.7 } as const;
export const B3_DS6_YEARLY: Record<string, number> = { 2011: 2.13, 2012: 6.63, 2013: -2.09, 2014: 6.47, 2015: 0.45, 2016: 11.58, 2017: 36.24, 2018: -21.83, 2019: 16.6, 2020: 38.91, 2021: -1.57, 2022: -27.47, 2023: 34.81, 2024: -6.89, 2025: 98.02, 2026: 47.62 };
