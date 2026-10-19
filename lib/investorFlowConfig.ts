// 투자자별 수급 1단계 수집(scripts/collect-investor-flow.ts) 기준값. 모두 사용자 지정(2026-10-19).

/** 외부 요청(KIS) 총 상한(사용자 확정 900건)과 요청 사이 최소 간격(ms). */
export const INVESTOR_FLOW_REQUEST_CAP = 900;
/** 시장 전체 수집 구간(KOSPI·KOSDAQ 공통). */
export const INVESTOR_FLOW_MARKET_FROM = "2008-10-01";
export const INVESTOR_FLOW_TO = "2026-10-16";
/** 시장별 TR 1회 행 수(2026-10-19 조사 관측), 종목별 TR 1회 행 수. */
export const INVESTOR_FLOW_MARKET_PAGE_ROWS = 300;
export const INVESTOR_FLOW_STOCK_PAGE_ROWS = 30;
/** 종목별 시험 수집 시작일(이 날짜 이전 행은 저장하지 않는다). */
export const INVESTOR_FLOW_STOCK_FROM = "2010-01-04";
/** 종목별 시험 대상(고정 4종목). 나머지 2개는 Parquet에서 규칙으로 고른 상장폐지 종목. */
export const INVESTOR_FLOW_FIXED_STOCKS = ["005930", "000660", "005380", "035420"] as const;
export const INVESTOR_FLOW_DELISTED_PICK = 2;
/** 시총 순위 풀(월말 PIT 기준 상위 N)과 상장폐지 판정 유예일(데이터 마지막 날 기준). */
export const INVESTOR_FLOW_TOP_N = 150;
export const INVESTOR_FLOW_ENDED_GRACE_DAYS = 14;
/** 호출 금지 시간대(운영 Routine 평일 14:10 KST와 겹치지 않게): KST 14:00~14:30 = UTC 05:00~05:30. */
export const INVESTOR_FLOW_BLOCK_UTC_FROM_MIN = 5 * 60;
export const INVESTOR_FLOW_BLOCK_UTC_TO_MIN = 5 * 60 + 30;
/** upsert 배치 크기. 저장 용량 추정에 쓰는 행당 바이트(키+숫자 컬럼+PK 인덱스, 가정). */
export const INVESTOR_FLOW_UPSERT_BATCH = 500;
export const INVESTOR_FLOW_BYTES_PER_STOCK_ROW = 150;

// ---- 2단계 B: 대형주 종목별 수집을 Storage Parquet로 저장(scripts/collect-investor-flow-stock.ts). 사용자 지정(2026-10-19). ----
/** 외부(KIS) 요청 누적 상한(회차 합산)과 연속 오류 중단 기준. */
export const INVESTOR_FLOW_STOCK_REQUEST_TOTAL_CAP = 56_000; // 2026-10-19 사용자가 50,000 → 56,000(이어받기 추가분 최대 6,000)으로 상향
export const INVESTOR_FLOW_CONSEC_ERROR_STOP = 20;
/** 한 회차 최대 실행 시간(워크플로 상한 5시간보다 짧게: 마지막 저장 여유 15분). */
export const INVESTOR_FLOW_STOCK_RUN_MAX_MS = 4.75 * 3600e3;
/** 저장 위치: 기존 주가 Parquet 버킷 안의 연구용 경로(기존 파일은 건드리지 않는다). */
export const INVESTOR_FLOW_STOCK_STORE_BUCKET = "stock-daily-prices";
export const INVESTOR_FLOW_STOCK_STORE_PREFIX = "research/investor_flow_stock";
export const INVESTOR_FLOW_STOCK_FIRST_YEAR = 2010;
/** 진행 저장 주기: 완료 종목 수 또는 경과 시간 중 먼저 오는 쪽. */
export const INVESTOR_FLOW_CHECKPOINT_STOCKS = 10;
export const INVESTOR_FLOW_CHECKPOINT_MS = 20 * 60e3;
/** 오류 응답 뒤 같은 요청을 다시 보내기 전 대기. */
export const INVESTOR_FLOW_ERROR_RETRY_MS = 2_000;
/** 주가 거래일과 대조해 정리한 사본의 저장 경로(원본 research/investor_flow_stock은 그대로 둔다). */
export const INVESTOR_FLOW_STOCK_CLEAN_PREFIX = "research/investor_flow_stock_clean";
