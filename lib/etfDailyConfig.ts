// 연구용 ETF 일봉 수집(scripts/collect-kis-etf-daily.ts) 기준값.

/** 수집 대상 ETF 6종(KIS 종목코드). */
export const ETF_DAILY_CODES = ["069500", "114260", "148070", "153130", "132030", "261240"] as const;

/** 조회 시작일. 069500은 사용자가 지정한 2008-01-01부터, 나머지는 상장 이전을 모두 덮는 이른 날짜(응답 기준 첫 거래일이 상장일). */
export const ETF_DAILY_START_BY_CODE: Record<string, string> = { "069500": "20080101" };
export const ETF_DAILY_DEFAULT_START = "19900101";

/** 조회 종료일(포함). */
export const ETF_DAILY_END = "20261016";

/** KIS 기간별 시세 한 번 호출의 최대 행수(2026-10-18 점검에서 관측). */
export const ETF_DAILY_PAGE_ROWS = 100;

/** 이번 수집의 KIS 요청 상한(사용자 확정: 500건). 도달하면 그 종목은 저장하지 않고 중단한다. */
export const ETF_DAILY_REQUEST_CAP = 500;

/** Supabase upsert 배치 크기. */
export const ETF_DAILY_UPSERT_BATCH = 500;

/** 수정/원주가 비율이 하루에 이 비율(%)을 넘게 바뀐 날짜를 목록으로 보고한다(사용자 지정 0.05%). */
export const ETF_RATIO_CHANGE_REPORT_PCT = 0.05;

/** 수정주가 일수익률 절댓값이 이 비율(%)을 넘는 날짜를 목록으로 보고한다(사용자 지정 10%). */
export const ETF_JUMP_REPORT_PCT = 10;

/** 연도별 수익률 비교 구간(069500 vs KOSPI). */
export const ETF_YEARLY_FROM = 2009;
export const ETF_YEARLY_TO = 2026;
