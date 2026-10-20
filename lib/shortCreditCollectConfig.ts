// 공매도·신용잔고 수집(scripts/collect-short-credit.ts) 기준값. 모두 사용자 지정(2026-10-19). 호출 금지 시간대·연속 오류·재시도 대기·진행 저장 주기·버킷은 lib/investorFlowConfig.ts를 그대로 쓴다.

/** 수집 기간(요청·저장 모두 이 범위만). */
export const SC_COLLECT_FROM = "2009-10-01";
export const SC_COLLECT_TO = "2016-12-31";
/** TR별 1회 최대 행 수(2026-10-19 조사 관측): 공매도 일별추이 100행, 신용잔고 일별추이 30행. */
export const SC_COLLECT_SHORT_PAGE_ROWS = 100;
export const SC_COLLECT_CREDIT_PAGE_ROWS = 30;
/** 신용잔고 화면 구분 코드(조사에서 사용한 값). */
export const SC_COLLECT_CREDIT_SCR_DIV = "20476";
/** 외부(KIS) 요청 누적 상한(공매도 + 신용잔고 합산, 회차 합산), 한 회차 최대 실행 시간(워크플로 상한 5시간보다 짧게: 마지막 저장 여유 15분). */
export const SC_COLLECT_REQUEST_TOTAL_CAP = 110_000;
export const SC_COLLECT_RUN_MAX_MS = 4.75 * 3600e3;
/** Storage 총량(전 버킷 합계) 상한(바이트). 초과할 것 같으면 중단. 사용자 지정 800MB(MiB 기준). */
export const SC_COLLECT_STORAGE_CAP_BYTES = 800 * 1048576;
/** 저장 용량 예측에 쓰는 행당 바이트: 실측 전에는 가정값, 실측 후에는 저장된 파일 크기 ÷ 행 수. */
export const SC_COLLECT_ASSUMED_BYTES_PER_ROW = 25;
/** 저장 경로(버킷은 INVESTOR_FLOW_STOCK_STORE_BUCKET). 원본, 정리본. */
export const SC_SHORT_PREFIX = "research/short_sale";
export const SC_CREDIT_PREFIX = "research/credit_balance";
export const SC_SHORT_CLEAN_PREFIX = "research/short_sale_clean";
export const SC_CREDIT_CLEAN_PREFIX = "research/credit_balance_clean";
/** 진행 파일 이름(각 원본 경로 안). */
export const SC_PROGRESS_FILE = "_progress.json";
/** 수집 기간 첫·마지막 연도(연도별 Parquet 범위). */
export const SC_FIRST_YEAR = 2009;
export const SC_LAST_YEAR = 2016;
/** 가격 Parquet의 첫 날(이 날 이후 상장한 종목은 첫 주가일을 조회 시작일로 쓴다). */
export const SC_PRICE_DATA_START = "2010-01-04";
/** 마지막 호출 로그 간격(요청 수). */
export const SC_COLLECT_LOG_EVERY_REQ = 200;
