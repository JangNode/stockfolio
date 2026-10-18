// 목표별 3계열(R·D·E) 자산 배분 연구(scripts/research-allocation-goals.ts, research/allocation-goals-prereg.md) 기준값.

/** 자산 코드(순서 고정: 주식, 국고채3년, 국고채10년, 금, 레버리지). */
export const ALLOC_GOALS_ASSETS = ["069500", "114260", "148070", "132030", "122630"] as const;

/** R 계열 기준(사용자 사전등록 2026-10-18). */
export const R_MDD_MARGIN_PP = 10.0;
/** D 계열 기준. */
export const D_MDD_RATIO = 0.5;
export const D_CAGR_RATIO = 0.7;
/** 지연 시 CAGR 하락 허용치(R·D·E 공통). */
export const GOALS_MAX_DELAY_DROP_PP = 1.0;

/** 정적 비중(순서: 069500, 114260, 148070, 132030, 122630). */
export const R2_WEIGHTS = [0, 0, 0.5, 0, 0.5] as const;
export const D1_WEIGHTS = [0.4, 0.3, 0, 0.3, 0] as const;
export const E2_WEIGHTS = [1 / 3, 1 / 3, 0, 1 / 3, 0] as const;
/** D2 방어 구간 비중. */
export const D2_DEFENSE_WEIGHTS = [0, 0.5, 0, 0.5, 0] as const;
