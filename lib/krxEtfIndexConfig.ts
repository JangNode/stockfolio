// ETF vs 기초지수 비교 점검(scripts/probe-krx-etf-index.ts) 기준값.

/** KRX 요청 상한(사용자 확정 200건). */
export const KRX_ETF_INDEX_REQUEST_CAP = 200;
export const KRX_ETF_INDEX_GAP_MS = 300;
/** 월말 수집 구간(KOSPI 거래일 기준 월 마지막 거래일). 수익률 계산을 위해 첫 달의 전월 말도 받는다. */
export const KRX_ETF_INDEX_FIRST_MONTH = "2011-10";
export const KRX_ETF_INDEX_LAST_MONTH = "2026-09";
/** 대상 종목(사용자 지정). */
export const KRX_ETF_INDEX_CODES = ["148070", "132030", "114260", "069500"] as const;
/** 월 수익률 차이 목록 기준(%p)과 목록 최대 개수. */
export const KRX_ETF_INDEX_DIFF_REPORT_PP = 0.5;
export const KRX_ETF_INDEX_LIST_MAX = 20;
/** 연환산 구간: [기준 월말(이 달의 마지막 거래일 종가), 종료 월말]. 마지막 구간의 종료는 수집 마지막 달. */
export const KRX_ETF_INDEX_PERIODS = [
  { label: "2013-01~2018-12", base: "2012-12", end: "2018-12" },
  { label: "2019-01~2022-12", base: "2018-12", end: "2022-12" },
  { label: "2023-01~끝", base: "2022-12", end: "2026-09" },
] as const;
