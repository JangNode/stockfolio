/**
 * 분할·병합(액면분할/병합) 조정계수 자체 탐지 기준값(RULES.md 2번 — 매직넘버는 여기에만).
 *
 * KRX 일별시세(stk_bydd_trd/ksq_bydd_trd)는 원가(미조정) 기준이라, 분할일에 종가가 급락/급등한
 * 것처럼 보인다. 국내 일일 가격제한폭은 ±30%(2015-06-15~, 그 이전 ±15%)라 하루 종가 변동이
 * ±30%를 넘으면 정상 시장 움직임이 아니라 권리 이벤트(또는 거래정지 후 재개·신규상장)다.
 * 그 후보 중 (1) 상장주식수 변화가 가격 변화와 정합하고 (2) 거래량이 같은 방향으로 움직이면
 * 분할·병합으로 자동 판정(적용), 아니면 저장만 하고 적용하지 않는다(2026-09-30 팀장 결정).
 */

// 후보 조건: 직전 거래일 종가 대비 비율이 이 범위 밖이면(= ±30% 이상 변동) 이벤트 후보.
export const PRICE_JUMP_RATIO_LOWER = 0.7;
export const PRICE_JUMP_RATIO_UPPER = 1.3;

// 상장주식수가 이 배수 이상(또는 역수 이하) 변했을 때만 "주식수 변화 동반"으로 본다.
export const SHARES_CHANGE_MIN_RATIO = 1.4;

// 이벤트 직후 상장주식수 반영이 하루이틀 늦을 수 있어, 이벤트일부터 이 개수의 행까지 본다.
export const SHARES_LOOKAHEAD_ROWS = 3;

// 가격비×주식수비(=그날 시가총액 변화)가 이 범위 안이면 시가총액이 연속이라 본다 — 정상
// 하루 변동(±30%)까지는 허용.
export const MARKET_CAP_CONTINUITY_LOWER = 0.7;
export const MARKET_CAP_CONTINUITY_UPPER = 1.3;

// 거래량 교차검증: 분할(주식수↑)이면 거래량이 이 배수 이상, 병합이면 그 역수 이하여야 한다.
export const VOLUME_AGREE_MIN_RATIO = 1.25;

// 거래정지 직후 판정: 직전 행과 이벤트 행 사이에 전 종목 합집합 거래일 캘린더 기준으로 이 일수 이상
// 빠져 있으면(거래정지일은 행을 저장하지 않는다) 거래정지 직후로 본다. 분할·병합은 거래정지를 동반하고
// 재개일 거래량은 방향이 불규칙하므로, 이때는 시가총액 연속 조건만으로 거래량 방향 검증을 대신한다
// (2026-10-04 팀장 결정).
export const HALT_MIN_MISSING_TRADING_DAYS = 1;

// 보정계수 스냅(2026-10-04 팀장 결정): 주식수비가 이 목록의 배수 또는 그 역수 중 하나에 이 비율 이내일
// 때만 그 값으로 맞춘다(상장주식수 변동 중 자사주 등 잡음 제거). 그 밖의 비율(무상증자 등)은 계산값 그대로.
export const ADJUSTMENT_SNAP_RATIOS = [2, 3, 4, 5, 10, 20, 25, 50, 100] as const;
export const ADJUSTMENT_SNAP_TOLERANCE = 0.01;

// 보류 규칙(2026-10-04 팀장 결정): 새로 적용되려는 이벤트라도 보정 후 (직전 종가 × 계수) / 이벤트일
// 종가가 이 범위 밖이면 적용하지 않고 low_confidence('post_ratio_out_of_range')로 목록만 남긴다.
export const POST_RATIO_LOWER = 0.7;
export const POST_RATIO_UPPER = 1.3;
export const POST_RATIO_OUT_OF_RANGE_REASON = "post_ratio_out_of_range";
// 보류 목록에 남기는 "후속 N거래일 등락" 기준 일수.
export const HOLD_FOLLOW_TRADING_ROWS = 5;

// 이 날짜 이후 이벤트만 스캔한다(직전 거래일 비교를 위해 그 이전 연도 시세도 함께 읽는다).
export const PRICE_ADJUSTMENT_SCAN_FROM_DATE = "2015-01-01";
export const PRICE_ADJUSTMENT_LOAD_FROM_YEAR = 2014;

// 방어 로직(추적·모의투자, 2026-10-04 팀장 결정): 국내 일일 가격제한폭(±30%, 2015-06-15 이전 ±15%)에 소수점
// 호가 반올림 여유를 더한 값. 이 폭을 넘는 일간 변동은 확정된 조정계수 이벤트가 없으면 자동 손절·익절·성과
// 집계에서 제외하고 'price_anomaly'로 표시한다.
export const DAILY_PRICE_LIMIT_RATIO = 0.305;
export const DAILY_PRICE_LIMIT_RATIO_BEFORE_CHANGE = 0.15;
export const PRICE_LIMIT_CHANGE_DATE = "2015-06-15";

// 일일 증분 스캔(2026-10-04): 최신 거래일부터 거슬러 이 개수의 거래일에 걸린 이벤트만 다시 판정한다 —
// 이벤트 직후 상장주식수 반영이 하루이틀 늦을 수 있어(SHARES_LOOKAHEAD_ROWS) 최신 거래일 하나만 보면
// 그 지연 때문에 저신뢰로 남는다. 전체 재스캔(주간)과 달리 KRX 호출은 (이 개수 + 1)거래일치뿐이다.
export const INCREMENTAL_SCAN_EVENT_TRADING_DAYS = 3;
