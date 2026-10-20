// 신호 스캔 3회차(scripts/research-signal-scan-short-credit.ts, research/signal-scan-short-credit-prereg.md) 기준값. 모두 사용자 사전등록(2026-10-20).
// 스캔 구간·유니버스·후보 기준·예측 기간은 lib/signalScanConfig.ts(SCAN_*)를 그대로 쓴다.

/** 공개 시차(CAL 거래일): 공매도는 신호일 1거래일 전까지, 신용잔고·대주잔고는 deal_date가 신호일 2거래일 전까지. */
export const SCS_SHORT_LAG_DAYS = 1;
export const SCS_CREDIT_LAG_DAYS = 2;
/** 공매도 비중 창(CAL 거래일): S1 20일, S2 60일, S3 = S1 − 바로 앞 60일. */
export const SCS_S1_DAYS = 20;
export const SCS_S2_DAYS = 60;
export const SCS_S3_PRIOR_DAYS = 60;
/** 신용잔고가 빈 날은 직전 값을 이 거래일 수까지 이어 쓴다(초과하면 결측). 신용잔고 증감률 비교 간격. */
export const SCS_CREDIT_CARRY_MAX_DAYS = 5;
export const SCS_C2_DAYS = 20;
/** 창 안 주가 있는 날 최소 비율(2/3, 수급 신호 규칙과 같음). */
export const SCS_MIN_PRICE_DAY_RATIO = 2 / 3;
/** 정리본 Storage 경로(공매도·신용잔고)와 연도 범위. */
export const SCS_SHORT_CLEAN_PREFIX = "research/short_sale_clean";
export const SCS_CREDIT_CLEAN_PREFIX = "research/credit_balance_clean";
export const SCS_FIRST_YEAR = 2009;
