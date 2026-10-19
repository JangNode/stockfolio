// 시장 수급 전략 연구(scripts/research-flow-timing.ts, research/flow-timing-prereg.md) 기준값. 모두 사용자 사전등록(2026-10-19).

/** 월말까지 순매수 금액을 합산하는 최근 거래일 수(기본)와 R1 주변 값. */
export const FLOW_SUM_DAYS = 60;
export const FLOW_R1_SUM_DAYS = [40, 90] as const;
/** 변형: 외국인 단독(F1) / 외국인·기관 동시 순매도(F2). 축소 상태 = 069500 50% + 114260 50%. */
export const FLOW_VARIANTS = [{ id: "F1" }, { id: "F2" }] as const;
export const FLOW_REDUCED_STOCK_WEIGHT = 0.5;
/** 관문(사전등록). */
export const FLOW_G1_CAGR_MARGIN_PP = 1.0;
export const FLOW_G4_MAX_DELAY_DROP_PP = 1.0;
/** R3 무작위 배치. */
export const FLOW_R3_DRAWS = 1000;
export const FLOW_R3_SEED = 20261019;
export const FLOW_R3_TOP_FRACTION = 0.05;
/** 정보용 통계 학습 창 끝(포함). */
export const FLOW_INFO_END = "2016-12-31";
