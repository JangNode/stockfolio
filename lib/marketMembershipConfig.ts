// 월말 시장 구분 수집(scripts/collect-market-membership.ts) 기준값. 사용자 지정(2026-10-21).

/** KRX Open API 주식 일별매매정보: KOSPI(stk_bydd_trd), KOSDAQ(ksq_bydd_trd). scripts/backfill-stock-daily-prices.ts와 같은 주소·인증 헤더(AUTH_KEY). */
export const MM_KRX_BASE_URL = "https://data-dbg.krx.co.kr/svc/apis/sto";
export const MM_ENDPOINTS = [["KOSPI", "stk_bydd_trd"], ["KOSDAQ", "ksq_bydd_trd"]] as const;
/** 수집 기간(가격 Parquet 달력 기준 매월 마지막 거래일, 마지막 달은 달력 마지막 날). */
export const MM_FROM_MONTH = "2010-01";
export const MM_TO_MONTH = "2026-10";
/** 외부 요청 상한(재시도 포함), 요청 사이 대기, 실패 시 재시도 횟수·대기. */
export const MM_REQUEST_CAP = 500;
export const MM_REQUEST_GAP_MS = 300;
export const MM_RETRY_COUNT = 2;
export const MM_RETRY_DELAY_MS = 1500;
/** 저장 경로(버킷은 INVESTOR_FLOW_STOCK_STORE_BUCKET): Parquet과 수집 기록(요청 수·빈 응답). */
export const MM_PARQUET_PATH = "research/market_membership/month_end.parquet";
export const MM_LOG_PATH = "research/market_membership/_log.json";
