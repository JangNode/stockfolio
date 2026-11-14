// 연구 묶음 4(M1~M3, 시도 291~293) 기준값. 사용자 지정 2026-11-14. 사전등록: docs/research/batch4-prereg.md
// 값은 첫 시험 전에 고정했고 결과를 본 뒤 바꾸지 않는다(사전 점검에서 발견한 논리 결함만 사유를 기록하고 고친다).
export const B4_PRIOR_TESTS = 290;
export const B4_TRIALS = { m1: 291, m2: 292, m3: 293 } as const;
/** "K200P" 순위 목록 깊이(묶음 1~3과 같음): 월말 시장 구분 코스피 구성원 중 제외 규칙 적용 뒤 판단일 시총 내림차순 상위 N종목. */
export const B4_RANK_DEPTH = 200;
/** 매크로 변화 계산 길이: 직전 한국 거래일 기준 값 x(c−1)과 20거래일 전 값 x(c−21)을 비교한다(20거래일 변화). */
export const B4_CHG_DAYS = 20;
/** 업종 코드 앞 자리 수(KSIC 중분류 2자리, DART induty_code 보완값; 종목별 현재 값 하나). */
export const B4_KSIC_PREFIX_LEN = 2;
/** 매크로 Parquet 시리즈 id(lib/macroDailyConfig.ts). M1 = 원/달러(ECOS 매매기준율), M2 = WTI(FRED), M3 = 국고채 10년(ECOS). */
export const B4_SERIES = { m1: "USDKRW_ECOS", m2: "WTI", m3: "KTB10Y" } as const;
export type B4P = Record<string, number>;
/**
 * 키 의미: thr = 진입 문턱(M1·M2 %, M3 %p; 변화율 = x(c−1) ÷ x(c−21) − 1, M3는 차이), hold = 보유 거래일(체결일부터), k = 업종당 종목 수(시총 상위 k).
 * 슬롯 수 = 2k, 슬롯 비중 = 1/(2k)(기본 k=3 → 6슬롯 × 1/6). M2는 thr를 상승(≥ +thr)·하락(≤ −thr) 양쪽에 같이 쓴다.
 */
export const B4_M1_P0: B4P = { thr: 3, hold: 20, k: 3 };
export const B4_M2_P0: B4P = { thr: 10, hold: 20, k: 3 };
export const B4_M3_P0: B4P = { thr: 0.2, hold: 20, k: 3 };
export const B4_M1_NB: [string, B4P][] = [["문턱 +2%", { thr: 2 }], ["문턱 +4%", { thr: 4 }], ["보유 10거래일", { hold: 10 }], ["보유 40거래일", { hold: 40 }], ["업종당 2종목", { k: 2 }], ["업종당 5종목", { k: 5 }]];
export const B4_M2_NB: [string, B4P][] = [["문턱 ±7%", { thr: 7 }], ["문턱 ±13%", { thr: 13 }], ["보유 10거래일", { hold: 10 }], ["보유 40거래일", { hold: 40 }], ["업종당 2종목", { k: 2 }], ["업종당 5종목", { k: 5 }]];
export const B4_M3_NB: [string, B4P][] = [["문턱 +0.15%p", { thr: 0.15 }], ["문턱 +0.25%p", { thr: 0.25 }], ["보유 10거래일", { hold: 10 }], ["보유 40거래일", { hold: 40 }], ["업종당 2종목", { k: 2 }], ["업종당 5종목", { k: 5 }]];
/** 업종 접두사(KSIC 중분류): M1 26(전자부품·컴퓨터·영상·음향·통신장비)·30(자동차·트레일러), M2 상승 19(코크스·연탄·석유정제품)·20(화학물질·제품), M2 하락 51(항공 운송), M3 64(금융)·65(보험·연금). */
export const B4_IND = { m1: ["26", "30"], m2up: ["19", "20"], m2dn: ["51"], m3: ["64", "65"] } as const;
/** 승률·손익 보고용: 진입 후 전방 수익률 거래일 수(5·10·20). */
export const B4_FWD_DAYS = [5, 10, 20] as const;
/** 게이트 F 참고선: 1 − 0.05 ÷ (이번 묶음의 시험 수). */
export const B4_F_DENOMINATOR = 3;
/** 사전 고지용 누적 시험 수(이번 묶음 마지막 번호). */
export const B4_CUM_TRIALS = 293;
