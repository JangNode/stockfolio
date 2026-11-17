// 전 종목 가격 데이터 품질 점검(미조정 기업행위 탐지, 소멸 처리 관례 제안) 기준값. 사용자 지정 2026-11-17, 사전 정의(결과를 보고 바꾸지 않음).
// 출처: 가격제한폭 — 한국거래소 유가증권·코스닥 시장 일일 가격제한폭 확대(±15% → ±30%, 2015-06-15 시행). 이 점검은 시험이 아니라 데이터 점검이며 시험 번호를 쓰지 않는다.
/** 이 날짜(포함)까지는 가격제한폭 ±15%, 다음 날부터 ±30%. */
export const DQ_LIMIT_CHANGE_DATE = "2015-06-14";
export const DQ_LIMIT_BEFORE = 0.15;
export const DQ_LIMIT_AFTER = 0.3;
/** 호가 단위 반올림·종가 산정 오차 허용(수익률 절댓값이 제한폭 + 이 값을 넘어야 초과로 본다). */
export const DQ_LIMIT_TOL = 0.005;
/** 신규상장 직후로 표시할 행 번호 상한(첫 행에는 직전 행이 없어 수익률이 없다. 이 번호 이하이면 표시). */
export const DQ_LISTING_MAX_ROW = 1;
/** 거래 재개로 표시할 직전 행과의 거래일 간격 하한(행 없는 날은 거래정지·미상장). */
export const DQ_RESUME_MIN_GAP = 2;
/** 정리매매로 표시할 소멸 종목의 마지막 행 개수(정리매매 7거래일). */
export const DQ_LIQUIDATION_ROWS = 7;
/** 분류: 시가총액 변화율이 수정 수익률과 이 비율(수정 수익률 절댓값 대비)보다 더 어긋나면 (가) 미조정 의심, 아니면 (나). */
export const DQ_MCAP_DIFF_FRAC = 0.5;
/** 소멸 처리 관례 제안(사용자 제안 2026-11-17): 소멸 직전 이 거래일 안에 거래정지(행 없는 날)가 이 일수 이상이거나 마지막 종가가 이 값 미만이면 전액 손실. */
export const DQ_VANISH_WINDOW_DAYS = 20;
export const DQ_VANISH_HALT_DAYS = 5;
export const DQ_VANISH_MIN_CLOSE = 1000;
/** 가격 기반 대안 신호(제안용): 마지막 N행 수익률이 이 값 이하이면 정리매매·부실 소멸 신호. */
export const DQ_ALT_LAST_ROWS = 7;
export const DQ_ALT_LAST_RETURN = -0.5;
/** 최근 소멸(마지막 행이 데이터 끝에서 이 거래일 안)은 아직 정지 중일 수 있어 미확정으로 따로 센다. */
export const DQ_RECENT_VANISH_DAYS = 10;
/** 목록 출력 상한(초과분은 건수만 표시). */
export const DQ_LIST_MAX = 400;
