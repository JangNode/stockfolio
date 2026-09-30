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

// 이 날짜 이후 이벤트만 스캔한다(직전 거래일 비교를 위해 그 이전 연도 시세도 함께 읽는다).
export const PRICE_ADJUSTMENT_SCAN_FROM_DATE = "2015-01-01";
export const PRICE_ADJUSTMENT_LOAD_FROM_YEAR = 2014;
