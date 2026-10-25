/**
 * 시장 국면(레짐) 카드 기준값. 값은 모두 관례적인 값이며 성과를 보고 최적화하지 않는다(2026-10-25 사용자 지정).
 * 판정 규칙·창 길이·구성 종목 정의를 바꿀 때는 이 파일만 보면 된다.
 */

// ---- 구성 종목: 코스피 시총 상위 200 (연구의 K200P와 같은 정의) ----
export const REGIME_TOP_N = 200;
// 20일 평균 거래대금 하한·창은 PIT 유니버스 상수(lib/strategyBacktestSummaryConfig.ts: 5억 원, 20거래일)를 그대로 쓴다.

// 제외 규칙: 우선주(종목코드 끝자리 ≠ 0), 스팩, 리츠·인프라투융자회사. 연구의 제외 규칙(satelliteV1Config)과 같은 값이다.
export const REGIME_SPAC_NAME_KEYWORDS = ["스팩", "기업인수목적"] as const;
export const REGIME_REIT_NAME_SUFFIX = "리츠";
/** KSIC 642(신탁업 및 집합투자업), 681(부동산 임대·공급). */
export const REGIME_REIT_KSIC_PREFIXES = ["642", "681"] as const;
export const REGIME_REIT_EXPLICIT_CODES = ["088980", "415640", "094800"] as const;
/** KIS 종목마스터 종목구분코드 중 주식(ST)만 구성 후보로 본다(리츠 RT, ETF EF, ETN EN 등 제외). */
export const REGIME_PRODUCT_TYPE_STOCK = "ST";

// ---- 지표 창 길이 ----
export const REGIME_MA_SHORT = 50;
export const REGIME_MA_LONG = 200;
/** NH = 55일 종가 신고가 종목 수 − 신저가 종목 수(직전 55개 종가 기준, 엄격 부등호). */
export const REGIME_NH_WINDOW = 55;
export const REGIME_DRAWDOWN_WINDOW = 252;
export const REGIME_VOL_WINDOW = 20;
export const REGIME_VOL_PCTILE_WINDOW = 252;
export const REGIME_TRADING_DAYS_PER_YEAR = 252;

// ---- 국면 규칙 (판정 순서: 위기 → 약세 → 강세 → 중립) ----
/** 위기: 252일 고점 대비 낙폭(%) ≤ 이 값 이고 B50 < REGIME_CRISIS_B50_BELOW. */
export const REGIME_CRISIS_DRAWDOWN_PCT = -15;
export const REGIME_CRISIS_B50_BELOW = 20;
/** 약세: KOSPI < 200일선 이고 B50 < 이 값. */
export const REGIME_BEAR_B50_BELOW = 40;
/** 강세: KOSPI > 200일선 이고 B50 ≥ 이 값 이고 NH > REGIME_BULL_NH_ABOVE. */
export const REGIME_BULL_B50_AT_LEAST = 60;
export const REGIME_BULL_NH_ABOVE = 0;
/** 국면 변경에 필요한 연속 같은 신호 일수(미충족이면 직전 국면 유지). */
export const REGIME_CONFIRM_DAYS = 3;

// ---- 이력·통계 ----
/** 국면별 과거 성과: 이후 이 거래일 수만큼의 KOSPI 지수 수익률(069500 일별 자료가 main에 없어 지수로 대체). */
export const REGIME_FORWARD_DAYS = 20;
/** 이력 백필 시작일(그 전에는 200일선·252일 고점이 없어 국면이 "미정"). */
export const REGIME_BACKFILL_FROM = "2010-07-01";
/** 화면 타임라인·이력 기본 길이(거래일). */
export const REGIME_TIMELINE_DAYS = 252;

// ---- 일일 배치 ----
/** KRX idx API 호출 사이 대기, 실패 재시도 대기(5·15·60초). */
export const REGIME_IDX_THROTTLE_MS = 300;
export const REGIME_RETRY_WAITS_MS = [5_000, 15_000, 60_000] as const;
/** 직전에 저장된 날 이후로 밀린 거래일을 한 번에 따라잡는 상한(넘으면 백필이 필요하다고 오류 처리). */
export const REGIME_MAX_CATCHUP_DAYS = 10;
/** 지수·종목 시계열을 읽을 과거 길이(달력 연수). 200일선·252일 고점·변동성 백분위에 충분한 2년. */
export const REGIME_LOOKBACK_YEARS = 2;
export const REGIME_STATUS_SOURCE = "MARKET_REGIME";

// ---- 이력 백필 전용 ----
/** 월말 시장 구분(PIT) 목록: 연구용 수집 파일. 이력 백필만 한 번 읽기 전용으로 읽으며 운영(일일) 배치는 이 경로에 의존하지 않는다. */
export const REGIME_BACKFILL_MEMBERSHIP_BUCKET = "stock-daily-prices";
export const REGIME_BACKFILL_MEMBERSHIP_PATH = "research/market_membership/month_end.parquet";
/** 지수 종가를 읽기 시작하는 날(2010-07 시점에 252일 고점·200일선이 정의되도록 충분히 앞선 날). */
export const REGIME_INDEX_FROM = "2009-01-01";
/** 종목 시세 Parquet 시작 연도(연구 자료와 같은 2010년부터). */
export const REGIME_PRICE_FROM_YEAR = 2010;

// ---- 화면(카드) ----
/** 마지막 계산일이 가장 최근 완료 거래일보다 이 거래일 수 이상 오래되면 카드 상단에 갱신 지연 경고를 띄운다. 일일 계산이 아직 안 돈 날 하루는 정상적으로 뒤처질 수 있어 2로 둔다. */
export const REGIME_STALE_WARN_TRADING_DAYS = 2;

/** 차트 기간 선택. 기간은 달력이 아니라 거래일 수로 자른다(1년 = REGIME_TIMELINE_DAYS와 같은 252거래일, 3년 = 756거래일). days가 null이면 전체. */
export const REGIME_CHART_PERIODS = [
  { key: "1y", label: "1년", days: 252 },
  { key: "3y", label: "3년", days: 756 },
  { key: "all", label: "전체", days: null },
] as const;
/** 화면에 나열하는 최근 국면 전환 건수. */
export const REGIME_RECENT_TRANSITIONS = 5;
