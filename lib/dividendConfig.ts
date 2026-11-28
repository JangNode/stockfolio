// 배당 시험용 DART "배당에 관한 사항"(alotMatter) 가능성 점검·수집 기준값. 사용자 지시 2026-11-28. 문서: docs/research/div-data-check.md (점검 기준은 호출 전에 커밋).
// 값은 호출 전에 고정했고 결과를 보고 바꾸지 않는다.
export const DIV_STORE_PREFIX = "research/dividend";
export const DIV_DATA_FILE = `${DIV_STORE_PREFIX}/dividend.parquet`;
export const DIV_PROGRESS_FILE = `${DIV_STORE_PREFIX}/_progress.json`;
/** 사업연도 범위(사업보고서 reprt_code 11011만). 접수는 사업연도 다음 해 3월경. */
export const DIV_FY_FROM = 2011;
export const DIV_FY_TO = 2025;
export const DIV_REPRT_CODE = "11011";
/** 종목 대상: 기존 재무 백필(저PBR·ROE)과 같은 종목 = 2011-03~2016-04 월말 구간 후보(소멸 포함, 약 2,127개사, corp_code 매핑된 종목). */
export const DIV_SIGNAL_FROM = "2011-03-01";
export const DIV_SIGNAL_TO = "2016-04-30";
/** list.json(정기공시, 정정 표기·원본 접수일 확인용) 조회 범위: FY2011 사업보고서(2012-03)부터 FY2025(2026-03~)까지. */
export const DIV_LIST_FROM = "20120101";
export const DIV_LIST_TO = "20261128";
export const DIV_LIST_PAGE_COUNT = 100;
/** DART 호출: 연구용 키만(3번 → 2번). 키당 하루 한도 20,000건의 80% = 16,000건 이내(사용자 지시 2026-11-28), 이 점검·수집의 전체 상한. */
export const DIV_KEY_ENVS = ["DART_API_KEY_3", "DART_API_KEY_2"] as const;
export const DIV_KEY_DAILY_LIMIT = 20_000;
export const DIV_KEY_DAILY_CAP = 16_000;
export const DIV_PILOT_CALL_CAP = 800;
export const DIV_TOTAL_CALL_CAP = 40_000;
export const DIV_GAP_MS = 150;
export const DIV_CONCURRENCY = 16;
export const DIV_MAX_RETRIES = 2;
export const DIV_RETRY_BASE_MS = 1000;
export const DIV_FETCH_TIMEOUT_MS = 90_000;
export const DIV_SOFT_DEADLINE_MINUTES = 170;
export const DIV_FLUSH_EVERY_CORPS = 100;
/**
 * 점검 표본 30개사: 지정 6개(보통주·우선주 둘 다 있는 삼성전자 005930·현대차 005380, 금융지주 KB금융 105560·신한지주 055550, 지주사 SK 034730·LG 003550)
 * + 소멸 4개(마지막 가격 행이 2012-04-01~2016-04-30) + 시총(2011-12 말) 구간 층화 20개(0~500억 7 · 500~2,000억 6 · 2,000~5,000억 4 · 5,000억 이상 3), 시드 20261128.
 */
export const DIV_PILOT = {
  seed: 20261128, refDate: "2011-12-31", named: ["005930", "005380", "105560", "055550", "034730", "003550"], vanished: 4, vanishedLastFrom: "2012-04-01", vanishedLastTo: "2016-04-30",
  bands: [[0, 500, 7], [500, 2000, 6], [2000, 5000, 4], [5000, Number.POSITIVE_INFINITY, 3]] as [number, number, number][],
};
/** 판정 기준(점검 전에 고정): 점검 통과 = ① 사업연도 1건당 호출 1회로 당기 값과 접수번호가 오고 ② 접수일(접수번호 앞 8자리)을 알 수 있고 ③ 기대(살아 있던) 회사-연도 중 보통주 주당 현금배당금 값이 확보되는 비율 ≥ 70% ④ 전체 호출이 키 일일 한도(80%) × 2키 안에서 2일 이내에 끝난다. */
export const DIV_PASS = { minCoverage: 0.7, maxDays: 2 };
