// 신용잔고 신호 증분 확인(scripts/research-credit-incremental.ts, research/credit-incremental-prereg.md) 기준값. 모두 사용자 사전등록(2026-10-20).
// 스캔 구간·유니버스·횡단면 최소 종목 수는 lib/signalScanConfig.ts(SCAN_*), 신용잔고 시차·이어쓰기는 lib/shortCreditScanConfig.ts(SCS_*)를 그대로 쓴다.

/** 예측 기간(거래일): 월21, 월63. 이중 정렬과 게이트는 63일. */
export const CI_HORIZONS = [21, 63] as const;
export const CI_GATE_HORIZON = 63;
/** 게이트: POOL·MID 모두 C1R 월63 순위상관 평균 < 0 이고 |t| ≥ 이 값. */
export const CI_GATE_ABS_T = 2.0;
/** 결측 변수(MOM·H52)를 대신 넣는 중앙 퍼센타일 순위. */
export const CI_MEDIAN_PERCENTILE = 0.5;
/** 이중 정렬 그룹 수(VOL 3등분, 각 그룹 안 C1 3등분)와 한 칸의 최소 종목 수. */
export const CI_GROUPS = 3;
export const CI_MIN_CELL = 3;
/** 회귀에서 변수의 분산이 이 값 이하이면 상수 열(전부 결측 대체)로 보고 그 달 회귀에서 뺀다. 소행렬 피벗 한계. */
export const CI_CONST_VAR_EPS = 1e-12;
export const CI_PIVOT_EPS = 1e-10;
