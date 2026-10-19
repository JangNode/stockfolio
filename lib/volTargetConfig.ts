// 변동성 목표화 연구(scripts/research-vol-target.ts, research/vol-target-prereg.md) 기준값. 모두 사용자 사전등록(2026-10-19).

/** 목표 연변동성과 리밸런싱 임계(현재 비중과 목표 비중의 차이). */
export const VOL_TARGET_ANNUAL = 0.15;
export const VOL_TARGET_REBALANCE_BAND = 0.10;
/** 변형별 변동성 측정 거래일 수. */
export const VOL_TARGET_VARIANTS = [{ id: "V1", n: 20 }, { id: "V2", n: 60 }] as const;
/** 관문 기준(계절성과 동일). */
export const VOL_TARGET_G1_CAGR_MARGIN_PP = 1.0;
export const VOL_TARGET_G4_MAX_DELAY_DROP_PP = 1.0;
