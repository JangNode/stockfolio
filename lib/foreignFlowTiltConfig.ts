// 대형주 외국인 수급 틸트 연구(scripts/research-foreign-flow-tilt.ts, research/foreign-flow-tilt-prereg.md) 기준값. 모두 사용자 사전등록(2026-10-19).

/** 유니버스: 월말 PIT 적격(시총 5,000억 이상 + 20일 평균 거래대금 5억 이상) 중 시총 상위 N. 정의는 기존 POOL(scripts/research-quarterly-tilt.ts)과 같다. */
export const FLOW_TILT_CAP_EOK = 5000;
export const FLOW_TILT_POOL_SIZE = 100;
/** 강도 창(거래일)과 R1 주변 값. 주가 있는 날의 최소 비율은 2/3(60일 중 40일). */
export const FLOW_TILT_WINDOW_DAYS = 60;
export const FLOW_TILT_R1_WINDOW_DAYS = [40, 90] as const;
export const FLOW_TILT_MIN_PRICE_DAY_RATIO = 2 / 3;
/** 3등분 곱(상위·중간·하위)과 K2 선별 개수. */
export const FLOW_TILT_MULT = [1.5, 1.0, 0.5] as const;
export const FLOW_TILT_K2_TOP_N = 30;
/** 수급 정리본 Storage 경로(scripts/clean-investor-flow-stock.ts가 만든 사본). */
export const FLOW_TILT_CLEAN_PREFIX = "research/investor_flow_stock_clean";
/** 첫 신호 월(월말 신호, 다음 거래일 체결)과 기간(사전등록). 홀드아웃 종료는 달력 마지막 거래일. */
export const FLOW_TILT_FIRST_SIGNAL_MONTH = "2010-03";
export const FLOW_TILT_LEARN = { from: "2010-04-01", to: "2016-12-31" } as const;
export const FLOW_TILT_CONFIRM = { from: "2017-01-01", to: "2021-12-31" } as const;
export const FLOW_TILT_HOLDOUT_FROM = "2022-01-01";
/** 관문(사전등록). */
export const FLOW_TILT_G1_CAGR_MARGIN_PP = 1.0;
export const FLOW_TILT_G3_MDD_MARGIN_PP = 5.0;
export const FLOW_TILT_G4_MAX_DELAY_DROP_PP = 1.0;
/** R2 기준(POOL 전 기간 CAGR + 1.0%p)과 R3 무작위 비교. */
export const FLOW_TILT_R_CAGR_MARGIN_PP = 1.0;
export const FLOW_TILT_R3_DRAWS = 1000;
export const FLOW_TILT_R3_SEED = 20261020;
export const FLOW_TILT_R3_TOP_FRACTION = 0.05;
/** 폐지 강제 청산 유예일(데이터 끝 기준, 기존 백테스트와 동일). */
export const FLOW_TILT_ENDED_GRACE_DAYS = 14;
