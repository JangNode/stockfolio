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
