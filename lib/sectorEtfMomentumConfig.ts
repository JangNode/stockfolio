// 업종 ETF 모멘텀 연구(scripts/research-sector-etf-momentum.ts, research/sector-etf-momentum-prereg.md) 기준값. 모두 사용자 사전등록(2026-10-19).

/** 후보 조건: 직전 20거래일 평균 거래대금 하한(원), 가격 이력 필요 길이(거래일). */
export const SECTOR_MOM_MIN_AVG_TV_WON = 100_000_000;
export const SECTOR_MOM_TV_SHORT_DAYS = 20;
export const SECTOR_MOM_TV_LONG_DAYS = 60;
export const SECTOR_MOM_HISTORY_DAYS = 252;
/** 신호: R12_1 = t−252 → t−21, R6 = t−126 → t. */
export const SECTOR_MOM_SKIP_DAYS = 21;
export const SECTOR_MOM_R6_DAYS = 126;
/** 상위 업종 수(= 슬롯 수). */
export const SECTOR_MOM_TOP_N = 3;
/** 비용: 편도 수수료 0.015% + 슬리피지 0.10%, 매도세 없음. */
export const SECTOR_MOM_FEE_RATE = 0.00015;
export const SECTOR_MOM_SLIPPAGE_RATE = 0.001;
/** 코드. */
export const SECTOR_MOM_BASE_CODE = "069500";
export const SECTOR_MOM_SAFE_CODE = "114260";
/** 기간. 홀드아웃 종료는 달력 마지막 거래일. */
export const SECTOR_MOM_LEARN = { from: "2011-01-01", to: "2016-12-31" } as const;
export const SECTOR_MOM_CONFIRM = { from: "2017-01-01", to: "2021-12-31" } as const;
export const SECTOR_MOM_HOLDOUT_FROM = "2022-01-01";
/** 관문. */
export const SECTOR_MOM_G3_MDD_MARGIN_PP = 5.0;
export const SECTOR_MOM_G5_MAX_DELAY_DROP_PP = 1.0;
export const SECTOR_MOM_TRADING_DAYS_PER_YEAR = 252;
export const SECTOR_MOM_READ_PAGE = 1000;
