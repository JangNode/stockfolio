/**
 * DART XBRL 백필(scripts/backfill-dart-xbrl-fundamentals.ts) 기준값. 추출 규칙(태그 우선순위·
 * 컨텍스트 순서)은 lib/dartXbrlExtract.ts에 고정돼 있고(커밋 f65e29a의 3차 점검 규칙과 동일),
 * 여기에는 수집 범위·실행 제어 상수만 둔다.
 */

/** 백필 대상 회계연도(own). FY2010은 FY2011 보고서의 전기 컨텍스트에서 prior_col로 따로 뽑는다. */
export const XBRL_BACKFILL_FISCAL_YEARS = [2011, 2012, 2013, 2014] as const;
export const XBRL_BACKFILL_PRIOR_COL_FISCAL_YEAR = 2010;

/** 결산월 12월 사업보고서만 대상: report_nm의 "(YYYY.12)". */
export const XBRL_BACKFILL_FISCAL_MONTH = 12;

/** list.json 조회 범위: FY2011 최초 공시(2012-03경)부터 FY2014 정정 포함 공시(2015-12)까지. */
export const XBRL_BACKFILL_LIST_FROM = "20120101";
export const XBRL_BACKFILL_LIST_TO = "20151231";
export const DART_LIST_PAGE_COUNT = 100;

/** 수집 대상 선정에만 쓰는 PIT 유니버스 시총 하한(억원). 신호·유니버스 판단과 무관. */
export const XBRL_BACKFILL_UNIVERSE_MIN_CAP_EOK = 5000;
export const XBRL_BACKFILL_PIT_FROM = "2010-01-01";

/** 실행 전 사전 계산 요청 수(종목×4 + list 수)가 이 값을 넘으면 실행하지 않고 보고한다. */
export const XBRL_BACKFILL_MAX_REQUESTS = 10_000;

/** 실행 제어. DART 응답에서 일일 한도 값은 확인되지 않아(status 020 메시지만 있음) 20,000건/일은 가정이다. */
export const XBRL_BACKFILL_CONCURRENCY = 4;
export const XBRL_BACKFILL_MIN_REQUEST_GAP_MS = 100;
export const XBRL_BACKFILL_MAX_RETRIES = 2;
export const XBRL_BACKFILL_RETRY_BASE_MS = 1000;
export const XBRL_BACKFILL_ASSUMED_DAILY_LIMIT = 20_000;
/** 워크플로 timeout-minutes보다 짧게 잡아, 이 시간이 지나면 새 종목을 시작하지 않고 저장·보고 후 멈춘다. */
export const XBRL_BACKFILL_SOFT_DEADLINE_MINUTES = 38;
export const XBRL_BACKFILL_PROGRESS_EVERY = 50;
export const XBRL_BACKFILL_UPSERT_BATCH = 200;
export const XBRL_BACKFILL_DB_IN_CHUNK = 200;

/** 이름 기준 금융 분류(보고용 구분일 뿐 수집·저장에는 쓰지 않는다). */
export const FIN_NAME_RE = /(은행|금융|증권|보험|화재|생명|카드|캐피탈|저축|손해|해상|재보험)/;
