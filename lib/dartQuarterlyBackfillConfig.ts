/**
 * DART 분기 실적 백필(scripts/backfill-dart-quarterly-fundamentals.ts) 기준값.
 * 대상 종목 선정(PIT 유니버스 진입 이력)은 dart_xbrl_fundamentals 백필과 같은 상수를 쓴다.
 */
export {
  XBRL_BACKFILL_UNIVERSE_MIN_CAP_EOK as QUARTERLY_BACKFILL_UNIVERSE_MIN_CAP_EOK,
  XBRL_BACKFILL_PIT_FROM as QUARTERLY_BACKFILL_PIT_FROM,
  XBRL_BACKFILL_CONCURRENCY as QUARTERLY_BACKFILL_CONCURRENCY,
  XBRL_BACKFILL_MIN_REQUEST_GAP_MS as QUARTERLY_BACKFILL_MIN_REQUEST_GAP_MS,
  XBRL_BACKFILL_MAX_RETRIES as QUARTERLY_BACKFILL_MAX_RETRIES,
  XBRL_BACKFILL_RETRY_BASE_MS as QUARTERLY_BACKFILL_RETRY_BASE_MS,
  XBRL_BACKFILL_UPSERT_BATCH as QUARTERLY_BACKFILL_UPSERT_BATCH,
  XBRL_BACKFILL_DB_IN_CHUNK as QUARTERLY_BACKFILL_DB_IN_CHUNK,
  XBRL_BACKFILL_SOFT_DEADLINE_MINUTES as QUARTERLY_BACKFILL_SOFT_DEADLINE_MINUTES,
} from "./dartXbrlBackfillConfig";

/** 회계연도 범위. FY2015는 점검(2026-10-16)에서 4종목 모두 CFS·OFS 013이라 제외한다. */
export const QUARTERLY_BACKFILL_FY_FROM = 2016;
export const QUARTERLY_BACKFILL_FY_TO = 2026;

/** quarter 1·2·3 ↔ DART reprt_code, 정상 접수월(12월 결산 기준). 점검에서 접수는 분기말 후 44~46일이었다. */
export const QUARTERLY_REPORTS = [
  { quarter: 1, reprtCode: "11013", qEndMmdd: "03-31", expectedRceptMonth: 5 },
  { quarter: 2, reprtCode: "11012", qEndMmdd: "06-30", expectedRceptMonth: 8 },
  { quarter: 3, reprtCode: "11014", qEndMmdd: "09-30", expectedRceptMonth: 11 },
] as const;

/** 분기말 + 이 일수가 오늘보다 미래면 아직 공시 전이므로 요청하지 않는다(013이 영구 저장되는 것을 막는다). */
export const QUARTERLY_BACKFILL_FILING_LAG_DAYS = 50;

/** 한 번 실행의 DART 요청 상한(재시도·OFS 폴백 포함). 승인 범위: 실행당 15,000건 이하. */
export const QUARTERLY_BACKFILL_RUN_REQUEST_CAP = 15_000;
export const QUARTERLY_BACKFILL_PROGRESS_EVERY_REQUESTS = 500;

/** 검증 표본 추출 시드와 크기. */
export const QUARTERLY_BACKFILL_VERIFY_SEED = 20261017;
export const QUARTERLY_BACKFILL_VERIFY_SAMPLE = 20;

/** 계정 매칭용 정규화 대상 account_id 접두사. */
export const QUARTERLY_ACCOUNT_PREFIX_RE = /^(ifrs-full|ifrs|dart)_/;
