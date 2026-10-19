// 공매도·신용잔고 데이터 조사(scripts/probe-short-credit.ts) 기준값. 모두 사용자 지정(2026-10-19).

/** 외부 요청(KRX + KIS 시도) 총 상한(사용자 확정 60건)과 KRX 요청 간격(ms). */
export const SC_PROBE_REQUEST_CAP = 60;
export const SC_PROBE_KRX_GAP_MS = 300;
/** 시험 기준일(005930)과 최신일. */
export const SC_PROBE_ANCHORS = ["20100104", "20130102", "20160701", "20210601", "20261016"] as const;
export const SC_PROBE_LATEST = "20261016";
/** 기준일에서 공매도 일별추이를 조회할 구간 길이(달력일). 최신일은 이 길이만큼 거슬러 올라간다. */
export const SC_PROBE_SHORT_WINDOW_DAYS = 30;
/** 더 이른 날짜 확인(2010-01-04에 응답이 있을 때만). */
export const SC_PROBE_EARLIER = ["20050104", "20000104"] as const;
/** 종목: 대형(삼성전자), 상장폐지(메리츠화재 000060), 비교 기준일. */
export const SC_PROBE_STOCK = "005930";
export const SC_PROBE_DELISTED = "000060";
export const SC_PROBE_DELISTED_ANCHOR = "20160701";
/** SMALL 유니버스 임의 1개: 2016-06-30 SMALL 구성원을 코드 오름차순으로 줄 세운 중앙값(코드는 실행 때 보고). */
export const SC_PROBE_SMALL_PICK_DATE = "2016-06-30";
/** 금지 기간 확인 구간(005930, 시작~종료). 금지 시작/해제 전후 포함. */
export const SC_PROBE_BAN_WINDOWS = [
  { label: "2020-03 금지 시작 전후", from: "20200302", to: "20200430" },
  { label: "2021-05 해제(005930) 전후", from: "20210419", to: "20210514" },
  { label: "2023-11 금지 시작 전후", from: "20231023", to: "20231117" },
  { label: "2025-03 해제 전후", from: "20250317", to: "20250411" },
] as const;
export const SC_BAN_PERIODS = [{ from: "2020-03-16", to: "2021-05-02" }, { from: "2023-11-06", to: "2025-03-30" }] as const;
/** KRX 후보 경로(서비스 목록 엔드포인트는 알려진 것이 없어 이름 추측 — 404=경로 없음, 401=미승인으로 구분). 기준일 2016-07-01. */
export const SC_PROBE_KRX_PATHS = ["sto/stk_short_bydd_trd", "sto/short_sell_bydd_trd", "sto/stk_short_balance_bydd", "sto/stk_loan_bydd_trd", "sto/stk_credit_bydd_trd", "sto/stk_ssts_bydd_trd"] as const;
export const SC_PROBE_KRX_DATE = "20160701";
/** 응답 앞·뒤 기록 행 수와 한 행 JSON 최대 길이. */
export const SC_PROBE_HEAD_ROWS = 1;
export const SC_PROBE_ROW_CHARS = 700;
/** 14:00~14:30 KST(= UTC 05:00~05:30)는 호출하지 않는다. */
export const SC_PROBE_BLOCK_UTC_FROM_MIN = 5 * 60;
export const SC_PROBE_BLOCK_UTC_TO_MIN = 5 * 60 + 30;
/** 용량 추정: 6열(코드·날짜·값 4개) 정리본의 실측 행당 바이트(수급 정리본 18,668,365 B ÷ 1,390,464행 = 13.43 B). */
export const SC_PROBE_PARQUET_BYTES_PER_ROW = 13.43;
/** 요청당 시간(초) 추정: 종목별 수급 수집의 실측(44,540건 ÷ 285.3분 ≈ 0.38초 / 5,460건 ÷ 35.7분 ≈ 0.39초)보다 보수적으로 0.6초와 0.9초. */
export const SC_PROBE_SEC_PER_REQ = [0.6, 0.9] as const;
