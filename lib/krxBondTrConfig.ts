// KRX 채권지수 총수익 검증 점검(scripts/probe-krx-bond-tr.ts) 기준값.

/** KRX 요청 상한(사용자 확정 250건). */
export const KRX_BOND_TR_REQUEST_CAP = 250;
/** 요청 간 간격(ms). */
export const KRX_BOND_TR_GAP_MS = 300;
/** 월말 수집 구간(KOSPI 거래일 기준 월 마지막 거래일). 수익률 계산을 위해 첫 달의 전월 말도 받는다. */
export const KRX_BOND_TR_FIRST_MONTH = "2011-10";
export const KRX_BOND_TR_LAST_MONTH = "2026-09";
/** 권한·필드 확인 기준일. */
export const KRX_BOND_TR_PROBE_DATE = "20261016";
/** 월 수익률 차이 목록 기준(%p). */
export const KRX_BOND_TR_DIFF_REPORT_PP = 0.5;
/** 분배금 조정이 없었던 구간(2026-10 보고서 3-2: 114260 비율 변화 2018-12-11 이후 2025-12-12 전까지 없음). */
export const KRX_BOND_TR_NO_ADJ_FROM_MONTH = "2018-12";
export const KRX_BOND_TR_NO_ADJ_TO_MONTH = "2025-11";
/** 상세 표 대상 후보의 최소 월 커버리지. */
export const KRX_BOND_TR_MIN_COVERAGE_MONTHS = 150;
