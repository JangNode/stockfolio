// 계절성 전략 연구(scripts/research-seasonality.ts, research/seasonality-prereg.md) 기준값. 모두 사용자 사전등록(2026-10-19).

export const SEASON_STOCK_CODE = "069500";
export const SEASON_BOND_CODE = "114260";

/** H1 핼러윈: 이 달의 마지막 거래일 종가에 주식으로 / 채권으로 전환. */
export const SEASON_H1_BUY_MONTH = 10;
export const SEASON_H1_SELL_MONTH = 4;
/** H2 월말·월초: 월말(L) 기준 L−4 종가에 주식 전환, 다음 달 3번째 거래일(= L+3) 종가에 채권 전환. */
export const SEASON_H2_ENTRY_BEFORE_DAYS = 4;
export const SEASON_H2_EXIT_AFTER_DAYS = 3;

/** 실행 시작일이 속한 연도(그 해 마지막 거래일 종가에 진입). 학습 창은 그 다음 해 1월부터. */
export const SEASON_RUN_START_YEAR = 2009;

/** 기간(사전등록). 홀드아웃 종료는 달력 마지막 거래일. */
export const SEASON_LEARN = { from: "2010-01-01", to: "2016-12-31" } as const;
export const SEASON_CONFIRM = { from: "2017-01-01", to: "2021-12-31" } as const;
export const SEASON_HOLDOUT_FROM = "2022-01-01";

/** 관문(사전등록). */
export const SEASON_G1_CAGR_MARGIN_PP = 1.0;
export const SEASON_G4_MAX_DELAY_DROP_PP = 1.0;

/** 정보용 통계(학습 창): 겨울 구간 월(11~4월). */
export const SEASON_WINTER_MONTHS = [11, 12, 1, 2, 3, 4] as const;
