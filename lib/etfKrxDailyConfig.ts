// KRX ETF 일별 수집(scripts/collect-krx-etf-daily.ts) 기준값.

/** KRX 요청 상한(사용자 확정 4,500건)과 요청 간 간격(ms), 진행 로그 간격. */
export const ETF_KRX_REQUEST_CAP = 4500;
export const ETF_KRX_GAP_MS = 300;
export const ETF_KRX_PROGRESS_EVERY = 250;
/** 수집 구간(KOSPI 지수 거래일 기준). */
export const ETF_KRX_FROM = "2010-01-01";
export const ETF_KRX_TO = "2026-10-16";
/** 업종 키워드와 관계없이 전 기간 저장하는 코드(비교 기준·안전자산). */
export const ETF_KRX_ALWAYS_CODES = ["069500", "114260"] as const;
/** upsert 배치 크기. */
export const ETF_KRX_UPSERT_BATCH = 1000;
