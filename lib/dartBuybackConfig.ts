/** DART 자기주식 취득 이벤트 수집(scripts/collect-dart-buyback-events.ts) 기준값. */
export const BUYBACK_FROM = "2010-01-01";
export const BUYBACK_TO = "2026-10-15";
/** 상세(API)는 이 날짜 이후 이벤트의 회사만 조회한다(점검 결과: 2015 이전은 확인하지 않음). */
export const BUYBACK_DETAIL_FROM = "20150101";
export const BUYBACK_DETAIL_TO = "20261015";
export const BUYBACK_LIST_PAGE_COUNT = 100;
export const BUYBACK_RUN_REQUEST_CAP = 4_000;
export const BUYBACK_SOFT_DEADLINE_MINUTES = 120;
export const BUYBACK_PROGRESS_EVERY_REQUESTS = 250;
/** report_nm 판정 문자열. 처분·해지는 제외하되 건수만 센다. */
export const BUYBACK_DIRECT_MARK = "자기주식취득결정";
export const BUYBACK_TRUST_MARK = "자기주식취득신탁계약체결결정";
export const BUYBACK_DISPOSAL_MARK = "자기주식처분";
export const BUYBACK_TERMINATE_MARK = "자기주식취득신탁계약해지";
export const BUYBACK_POOL_SIZE = 100;
export const BUYBACK_DUP_WINDOW_DAYS = 30;
export const BUYBACK_UPSERT_BATCH = 200;
