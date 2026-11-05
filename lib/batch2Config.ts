// 연구 묶음 2(R1~R4, 시도 282~285) 기준값. 사용자 지정 2026-11-05. 사전등록: docs/research/batch2-prereg.md
// 값은 첫 시험 전에 고정했고 결과를 본 뒤 바꾸지 않는다(사전 점검에서 발견한 논리 결함만 사유를 기록하고 고친다).
export const B2_PRIOR_TESTS = 281;
export const B2_TRIALS = { r1: 282, r2: 283, r3: 284, r4: 285 } as const;
/** "K200P" 순위 목록 깊이(묶음 1과 같음): 월말 시장 구분 코스피 구성원 중 제외 규칙 적용 뒤 판단일 시총 내림차순 상위 N종목. 이 밖의 순위는 OUT_RANK. */
export const B2_RANK_DEPTH = 200;
export const B2_OUT_RANK = 201;
/** 각 가설의 기본 파라미터(P0)와 게이트 D 이웃(하나씩만 변경). 키 의미는 docs/research/batch2-prereg.md 1~4절. */
export type B2P = Record<string, number>;
/** R1: pos = 종가 위치 하한((종가−저가)/(고가−저가)), vol = 거래대금 배수, avgWin = 직전 평균 행 수, ma = 이동평균 일수, hold = 보유 거래일. */
export const B2_R1_P0: B2P = { pos: 0.9, vol: 2, avgWin: 20, ma: 60, hold: 5, slots: 10 };
export const B2_R1_NB: [string, B2P][] = [["종가 위치 ≥ 0.8", { pos: 0.8 }], ["종가 위치 ≥ 0.95", { pos: 0.95 }], ["거래대금 배수 1.5", { vol: 1.5 }], ["거래대금 배수 3", { vol: 3 }], ["이동평균 40일", { ma: 40 }], ["이동평균 120일", { ma: 120 }], ["보유 3거래일", { hold: 3 }], ["보유 8거래일", { hold: 8 }]];
/** R2: idx = 시장 지수 구성 종목 수, win = 수익률 비교 창, confirm = 전환 확인 일수, n = 보유 종목 수. */
export const B2_R2_P0: B2P = { idx: 50, win: 60, confirm: 5, n: 10 };
export const B2_R2_NB: [string, B2P][] = [["비교 창 40거래일", { win: 40 }], ["비교 창 90거래일", { win: 90 }], ["전환 확인 3거래일", { confirm: 3 }], ["전환 확인 8거래일", { confirm: 8 }], ["보유 종목 수 5", { n: 5 }], ["보유 종목 수 20", { n: 20 }], ["지수 구성 종목 수 30", { idx: 30 }], ["지수 구성 종목 수 100", { idx: 100 }]];
/** R2 같은 시장 안 보유 종목 교체 확인 일수(DS6 코어와 같음, coreSatelliteConfig CS_SWAP_CONFIRM_DAYS). */
export const B2_R2_SWAP_CONFIRM = 5;
/** R3: low = 신저가 기준 거래일 수(직전 low−1일 최솟값보다 작으면 신저가), within = 신저가 확인 창, rec = 회복률, ma = 이동평균, timeout = 보유 상한. */
export const B2_R3_P0: B2P = { low: 252, within: 20, rec: 0.08, ma: 20, timeout: 20, slots: 10 };
export const B2_R3_NB: [string, B2P][] = [["회복률 +6%", { rec: 0.06 }], ["회복률 +10%", { rec: 0.1 }], ["신저가 확인 창 10거래일", { within: 10 }], ["신저가 확인 창 30거래일", { within: 30 }], ["이동평균 10일", { ma: 10 }], ["이동평균 30일", { ma: 30 }], ["보유 상한 10거래일", { timeout: 10 }], ["보유 상한 30거래일", { timeout: 30 }]];
/** R4: win = 회귀 창, skip = 제외할 최근 거래일 수, depth = 유니버스 시총 상위 N, n = 보유 종목 수(슬롯), exitRank = 청산 순위(이 순위 밖이면 청산). */
export const B2_R4_P0: B2P = { win: 252, skip: 21, depth: 150, n: 20, exitRank: 40 };
export const B2_R4_NB: [string, B2P][] = [["회귀 창 126거래일", { win: 126 }], ["회귀 창 378거래일", { win: 378 }], ["제외 기간 10거래일", { skip: 10 }], ["제외 기간 42거래일", { skip: 42 }], ["유니버스 상위 100", { depth: 100 }], ["유니버스 상위 200", { depth: 200 }], ["보유 15(청산 순위 30)", { n: 15, exitRank: 30 }], ["보유 30(청산 순위 60)", { n: 30, exitRank: 60 }], ["청산 순위 30", { exitRank: 30 }], ["청산 순위 60", { exitRank: 60 }]];
/** 게이트 F 참고선: 1 − 0.05 ÷ (이번 묶음의 시험 수). */
export const B2_F_DENOMINATOR = 4;
/** 보고용 DS6 기록(연속 전체 CAGR / MDD, 연 회전율 %, 비용 합계 %)과 연도별 수익률 %(2011은 01-04부터, 2026은 10-26까지). 묶음 1과 같은 값. */
export const B2_DS6_REC = { 전체: [11.7, 39.15], 구간1: [4.11, 24.51], 구간2: [9.17, 30.78], 구간3: [22.54, 33.66], turnover: 303.95, cost: 20.7 } as const;
export const B2_DS6_YEARLY: Record<string, number> = { 2011: 2.13, 2012: 6.63, 2013: -2.09, 2014: 6.47, 2015: 0.45, 2016: 11.58, 2017: 36.24, 2018: -21.83, 2019: 16.6, 2020: 38.91, 2021: -1.57, 2022: -27.47, 2023: 34.81, 2024: -6.89, 2025: 98.02, 2026: 47.62 };
