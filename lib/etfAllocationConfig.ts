// ETF 자산 배분 연구(scripts/research-etf-allocation.ts, research/etf-allocation-prereg.md) 기준값.

/** 자산 코드(순서 고정: 주식, 국고채3년, 국고채10년, 금). */
export const ETF_ALLOC_ASSETS = ["069500", "114260", "148070", "132030"] as const;

/** 하루짜리 튐 정제: 사용자 사전등록(2026-10-18). */
export const ETF_SPIKE_MIN_ABS_RET = 0.08;
export const ETF_SPIKE_MAX_NET_ABS = 0.02;
/** 069500 정제 면제: 같은 날 KOSPI 수익률 부호가 같고 크기가 이 비율 이상이면 실제 변동. */
export const ETF_SPIKE_KOSPI_EXEMPT_RATIO = 0.5;
/** 정제 후에도 목록으로만 보고하는 큰 일변동 기준. */
export const ETF_BIG_MOVE_REPORT_ABS_RET = 0.10;

/** 비용: 편도 수수료 0.015% + 슬리피지 0.05%, ETF 매도세 없음(사용자 사전등록). */
export const ETF_FEE_RATE = 0.00015;
export const ETF_SLIPPAGE_RATE = 0.0005;

/** 첫 결정일이 속한 연월(그 달의 마지막 거래일). */
export const ETF_RUN_FIRST_DECISION_MONTH = "2012-12";

/** 변형 파라미터(사전등록). */
export const ETF_A1_WEIGHTS = [0.5, 0, 0.3, 0.2] as const; // 069500, 114260, 148070, 132030
export const ETF_A2_SMA_MONTHS = 10;
export const ETF_A3_LOOKBACK_MONTHS = 12;
export const ETF_A4_VOL_DAYS = 60;

/** 기간(사전등록). 홀드아웃 종료일은 달력 마지막 거래일. */
export const ETF_LEARN = { from: "2013-01-01", to: "2018-12-31" } as const;
export const ETF_CONFIRM = { from: "2019-01-01", to: "2022-12-31" } as const;
export const ETF_HOLDOUT_FROM = "2023-01-01";

/** 관문 기준(사전등록). */
export const ETF_G1_CAGR_MARGIN_PP = 2.0;
export const ETF_G2_MDD_RATIO = 0.7;
export const ETF_G4_MAX_DELAY_DROP_PP = 1.0;

export const ETF_TRADING_DAYS_PER_YEAR = 252;
