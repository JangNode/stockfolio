// 신호 스캔 연구(scripts/research-signal-scan.ts, research/signal-scan-prereg.md) 기준값. 모두 사용자 사전등록(2026-10-19).

/** 스캔 구간(학습만). 이 날짜를 넘는 가격·재무·수급·공시 행은 읽은 뒤 바로 버린다. */
export const SCAN_START = "2010-04-01";
export const SCAN_END = "2016-12-31";
/** 예측 기간(거래일)과 표본 종류별 간격(Newey-West 시차 산정). 월간 21, 주간 5. */
export const SCAN_HORIZONS = [5, 21, 63] as const;
export const SCAN_SPACING_MONTHLY_DAYS = 21;
export const SCAN_SPACING_WEEKLY_DAYS = 5;
/** 유니버스(POOL 정의와 동일): 시총 5,000억 이상 + 20일 평균 거래대금 5억 이상 중 시총 상위 100. */
export const SCAN_CAP_EOK = 5000;
export const SCAN_POOL_SIZE = 100;
/** 표본일 하나에서 통계를 낼 최소 종목 수(신호·수익률 모두 있는 종목), BB(0/1) 차이의 신호 1 최소 종목 수. */
export const SCAN_MIN_CROSS_SECTION = 20;
export const SCAN_MIN_EVENT_NAMES = 3;
/** 후보 표시 기준: |t| ≥ 3.0 그리고 방향 반영 순차이 > 0. */
export const SCAN_CANDIDATE_ABS_T = 3.0;
/** 수급 강도 창(CAL 거래일)과 주가 있는 날 최소 비율(2/3). */
export const SCAN_FLOW_WINDOWS = { F: [5, 20, 60], O: [20, 60], P: [20, 60] } as const;
export const SCAN_FLOW_MIN_PRICE_DAY_RATIO = 2 / 3;
/** 가격 신호 창(거래일). */
export const SCAN_MOM_LONG_DAYS = 252;
export const SCAN_MOM_SKIP_DAYS = 21;
export const SCAN_H52_DAYS = 252;
export const SCAN_H52_MIN_ROWS = 200;
export const SCAN_VOL_DAYS = 60;
export const SCAN_VOL_MIN_RETURNS = 40;
export const SCAN_TVG_DAYS = 20;
/** 재무·공시: 분기 신선도(일), 배당 창(일), 자사주 공시 창(일). */
export const SCAN_QUARTER_FRESH_DAYS = 150;
export const SCAN_DIVIDEND_WINDOW_DAYS = 365;
export const SCAN_BUYBACK_WINDOW_DAYS = 60;
export const SCAN_DB_CHUNK = 100;

// ---- 스캔 2회차(중소형주, research/signal-scan-smallmid-prereg.md) 사용자 사전등록(2026-10-19) ----
/** SMALL 유니버스: 직전 행 시총 1,000억 이상 5,000억 미만 + 20일 평균 거래대금 2억 이상 + 원본 종가 1,000원 이상. 상한(5,000억)은 SCAN_CAP_EOK. */
export const SCAN_SMALL_MIN_MCAP_EOK = 1000;
export const SCAN_SMALL_MIN_AVG_TV_WON = 200_000_000;
export const SCAN_SMALL_MIN_PRICE_WON = 1000;
/** SMALL 비용: 슬리피지만 0.2%(수수료·거래세는 기존 규칙). */
export const SCAN_SMALL_SLIPPAGE = 0.002;
/** 폐지 종목 집계: 마지막 행이 학습 구간 끝 − 이 일수 이전이면 폐지로 센다. */
export const SCAN_ENDED_GRACE_DAYS = 14;
