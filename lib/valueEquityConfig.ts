// 저평가(PBR) 시험용 2016년 이전 자본 수집(파일럿·본 수집) 기준값. 사용자 승인 2026-11-20. 문서: docs/research/value-data-check.md (파일럿 기준은 파일럿 호출 전에 커밋, db14d26).
// 값은 호출 전에 고정했고 결과를 보고 바꾸지 않는다.
export const VEQ_STORE_PREFIX = "research/v_equity";
export const VEQ_DATA_FILE = `${VEQ_STORE_PREFIX}/fin_pre2016.parquet`;
export const VEQ_PROGRESS_FILE = `${VEQ_STORE_PREFIX}/_progress.json`;
/** 시험 신호일 구간(2011-03 첫 월말부터 R 자료가 시작되는 2016-04까지)과 list.json 조회 범위. */
export const VEQ_SIGNAL_FROM = "2011-03-01";
export const VEQ_SIGNAL_TO = "2016-04-30";
export const VEQ_LIST_FROM = "20110101";
export const VEQ_LIST_TO = "20160430";
export const VEQ_LIST_PAGE_COUNT = 100;
/** 파일럿(사업보고서 기준 자본 확보율 30% 이상이면 본 수집 진행). */
export const VEQ_PILOT = {
  n: 30, seed: 20261120, refDate: "2011-12-31", fyFrom: 2011, fyTo: 2014,
  vanished: 5, vanishedLastFrom: "2012-04-01", vanishedLastTo: "2016-04-30",
  /** 생존 25개의 시총(억원) 구간별 정원: [하한 이상, 상한 미만, 정원]. */
  bands: [[0, 500, 9], [500, 2000, 8], [2000, 5000, 5], [5000, Number.POSITIVE_INFINITY, 3]] as [number, number, number][],
  quarterlyCompanies: 10, quarterlyFy: 2013,
  passAnnualCapture: 0.3,
};
/** 접수 예정일 가정(기대 보고서 수 계산): 사업 익년 3월 31일, 반기·분기 기말 + 45일. */
export const VEQ_ANNUAL_DUE_MMDD = "03-31";
export const VEQ_QUARTER_DUE_DAYS = 45;
/** DART 호출: 연구용 키만(3번 → 2번), 키당 하루 18,000건 이내, 이 연구 전체 상한. */
export const VEQ_KEY_ENVS = ["DART_API_KEY_3", "DART_API_KEY_2"] as const;
export const VEQ_KEY_DAILY_CAP = 18_000;
export const VEQ_TOTAL_CALL_CAP = 60_000;
export const VEQ_GAP_MS = 150;
export const VEQ_CONCURRENCY = 4;
export const VEQ_MAX_RETRIES = 2;
export const VEQ_RETRY_BASE_MS = 1000;
/** 응답 대기 상한(응답이 멈춘 호출이 수집 전체를 붙잡지 않게). 시간 초과는 재시도 대상. */
export const VEQ_FETCH_TIMEOUT_MS = 90_000;
export const VEQ_SOFT_DEADLINE_MINUTES = 170;
export const VEQ_FLUSH_EVERY_CORPS = 100;
export const VEQ_USER_EQUITY_LOCAL = "Equity";
export const VEQ_PARENT_EQUITY_LOCAL = "EquityAttributableToOwnersOfParent";
