// 투자자별 매매 데이터 확보 가능성 조사(scripts/probe-investor-data.ts) 기준값.

/** 외부 요청(KRX + KIS) 총 상한(사용자 확정 30건). */
export const INVESTOR_PROBE_REQUEST_CAP = 30;
/** KRX 요청 간 간격(ms). */
export const INVESTOR_PROBE_KRX_GAP_MS = 300;
/** 조회 날짜. */
export const INVESTOR_PROBE_DATES = ["20100104", "20150105", "20261016"] as const;
/** KRX 후보 경로(서비스 목록 엔드포인트는 알려진 것이 없어 이름 추측 — 404=경로 없음, 401=미승인으로 구분). */
export const INVESTOR_PROBE_KRX_PATHS = ["sto/invstr_bydd_trd", "sto/stk_invstr_trd", "sto/stk_bydd_invstr", "idx/kospi_invstr_dd_trd"] as const;
/** KIS 조회 대상 종목(삼성전자)과 시장 코드. */
export const INVESTOR_PROBE_STOCK = "005930";
/** 응답 앞부분 기록 행 수와 한 행 JSON 최대 길이. */
export const INVESTOR_PROBE_HEAD_ROWS = 2;
export const INVESTOR_PROBE_ROW_CHARS = 320;
/** 저장 용량 추정에 쓰는 행당 바이트(키 + 숫자 3열 + PK 인덱스, 가정). */
export const INVESTOR_PROBE_BYTES_PER_ROW = 100;
