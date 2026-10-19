// 주간 배치 후 화면 수치 확인(scripts/check-peg-screen.ts) 기준값.

/** 확인 대상 주간 배치의 실행 시작(UTC) 하한. 이 시각 이후 computed_at 행을 "새 값", 이전 행을 "이전 값"으로 본다. */
export const SCREEN_CHECK_NEW_FROM = "2026-10-18T20:00:00Z";
/** 이전 값 후보는 이 시각 이전의 가장 최근 행. */
export const SCREEN_CHECK_PREV_BEFORE = "2026-10-18T20:00:00Z";
/** peg_lynch를 보는 화면 stage 3개. */
export const SCREEN_CHECK_PEG_STAGES = ["pit_adjusted_cap5000_from2010", "pit_adjusted_cap5000", "pit_adjusted_cap5000_from_signal"] as const;
/** 변동 확인 대상 stage(전략 전체). */
export const SCREEN_CHECK_ALL_STAGES = ["pit_adjusted", "pit_adjusted_cap5000", "pit_adjusted_cap5000_from2010", "pit_adjusted_cap5000_from_signal"] as const;
/** 재계산 시작일(화면 2010~ stage와 같음)과 연구 참조 구간 시작일(T69). */
export const SCREEN_CHECK_RECALC_START = "2010-01-01";
export const SCREEN_CHECK_REF_STARTS = ["2016-03-01", "2021-03-01"] as const;
/** 재무 로드 청크 크기. */
export const SCREEN_CHECK_DB_CHUNK = 100;
/** 화면 저장값과 재계산 값을 같다고 보는 허용 오차(CAGR·MDD %p). */
export const SCREEN_CHECK_TOLERANCE_PP = 0.05;
