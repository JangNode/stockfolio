// KODEX 200 + 업종 모멘텀 위성 v3(scripts/research-kodex-sector-satellite-v3.ts, research/kodex-sector-satellite-v3-prereg.md) 기준값. 모두 사용자 사전등록(2026-10-22).
// 업종 모멘텀 정의·K200P는 lib/sectorMomTiltConfig.ts, 되돌림 폭·069500 비용은 lib/satelliteV1Config.ts(SAT_MIX_BAND, SAT_ETF_COST_PER_SIDE)를 쓴다.

/** 위성: 업종 모멘텀 상위 업종 수. */
export const KSS_TOP_K = 3;
/** 조합 위성 비중(90:10, 80:20, 70:30, 50:50, 0:100)과 기본(80:20). */
export const KSS_MIX_WEIGHTS = [0.1, 0.2, 0.3, 0.5, 1.0] as const;
export const KSS_DEFAULT_W = 0.2;
/** 참고 기준(80:20 vs B&H 가격): G1 CAGR ≥ +0.3%p, G2 MDD ≤ +3.0%p, G4 지연 하락 ≤ 0.5%p (G3 샤프 ≥ B&H). */
export const KSS_G1_MARGIN_PP = 0.3;
export const KSS_G2_MDD_MARGIN_PP = 3.0;
export const KSS_G4_MAX_DELAY_DROP_PP = 0.5;
/** R1 주변 값, R3 무작위 비교. */
export const KSS_R1_LOOKBACKS = [3, 12] as const;
export const KSS_R1_TOP_KS = [2, 4] as const;
export const KSS_R3_DRAWS = 1000;
export const KSS_R3_SEED = 20261022;

// ---- v3.1 (research/kodex-sector-satellite-v3_1-prereg.md, 사용자 지정 2026-10-22) ----
/** 업종별 위성 종목 수(시총 상위)와 R1 주변 값. */
export const KSS31_PER_SECTOR = 3;
export const KSS31_R1_LOOKBACKS = [3, 9, 12] as const;
export const KSS31_R1_PER_SECTOR = [2, 5] as const;
/** 실투자 점검: 최소 운용 금액 집계 시작 월, 계좌 크기(원), 최근 신호일 수. */
export const KSS31_PRACTICAL_FROM = "2024-01";
export const KSS31_ACCOUNTS_WON = [10_000_000, 30_000_000, 100_000_000] as const;
export const KSS31_RECENT_SIGNALS = 12;

// ---- v3.2 (research/kodex-sector-satellite-v3_2-prereg.md, 사용자 지정 2026-10-22) ----
/** A 정리 기준: 80:20 기준 계좌 전체 비중이 이 값 미만인 위성 종목 제외. R1 주변 값. */
export const KSS32_TRIM_MIN_WEIGHT = 0.01;
export const KSS32_R1_TRIMS = [0.005, 0.02] as const;
/** B 실제 시드(원), 위성 실제 비중 상한, 069500 슬리피지(편도). 주식 비용은 lib/transactionCost.ts. */
export const KSS32_SEEDS_WON = [1_000_000, 3_000_000, 5_000_000, 7_000_000, 10_000_000] as const;
export const KSS32_SAT_CAP = 0.3;
export const KSS32_ETF_SLIPPAGE = 0.0005;

// ---- 연구 B·C (docs/research/bc-weight-defense-prereg.md, a28dfbd) ----
/** B: 새로 실행하는 비중 변형(069500:위성 = 60:40)과 그 정수 주 모의의 위성 평가 상한(= 위성 목표 + 10%p). */
export const BC_B_WEIGHT = 0.4;
export const BC_B_SAT_CAP = 0.5;
/** B의 R 통과 기준(이번 사전등록에서 새로 정함): R3 CAGR 백분위 하한. R1·R2는 B&H 가격 전 기간 CAGR 초과. */
export const BC_R3_MIN_PCTILE = 95;
/** C: 069500 월말 원 종가 이동평균 개월 수(기본, R1 이웃값), C2의 "위" 노출. */
export const BC_C_MA_MONTHS = 10;
export const BC_C_R1_MA_MONTHS = [8, 12] as const;
export const BC_C2_EXPOSURE = 0.7;
/** C 판정: G1 CAGR ≥ 5%, G2 일별 MDD ≤ 15%, G3 최악 12개월 ≥ −15%. */
export const BC_C_G1_MIN_CAGR = 5;
export const BC_C_G2_MAX_MDD = 15;
export const BC_C_G3_MIN_WORST12 = -15;

// ---- 연구 D (docs/research/d-frequency-prereg.md, 5194e70) ----
/** 069500 원 종가 이동평균 거래일 수(기본, R1 이웃값). */
export const D_SMA_DAYS = 20;
export const D_R1_SMA_DAYS = [10, 40] as const;
/** D3 계좌 손절 비율(고점 대비, 기본, R1 이웃값). */
export const D_STOP = 0.1;
export const D_R1_STOPS = [0.07, 0.15] as const;
/** R3 백분위 하한. */
export const D_R3_MIN_PCTILE = 95;
/** 추가 보고 구간: 2026-09-30 종가 → 2026-10-15 종가. */
export const D_RECENT_FROM = "2026-09-30";
export const D_RECENT_TO = "2026-10-15";
