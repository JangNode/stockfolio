// 적정주가 RIM(잔여이익모델)의 요구수익률(CAPM) 계산에 쓰는 베타 산출 기준값.
export const BETA_LOOKBACK_YEARS = 3; // 회귀 기간(~750거래일). 상장 3년 미만은 산출 불가 처리.
export const BETA_MIN_DATA_POINTS = 500; // 최소 데이터 포인트(일별수익률 교집합 쌍의 수)
