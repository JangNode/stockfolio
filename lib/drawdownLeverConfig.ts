// 역발상 레버리지 연구(scripts/research-drawdown-lever.ts, research/drawdown-lever-prereg.md) 기준값. 모두 사용자 사전등록(2026-10-19).

export const DD_LEVER_STOCK_CODE = "069500";
export const DD_LEVER_LEVER_CODE = "122630";
/** 낙폭 측정 기간(당일 포함 거래일 수). */
export const DD_LEVER_HIGH_WINDOW_DAYS = 252;
/** 확대 진입(D ≤ 이 값)·복귀(D ≥ 이 값) 임계. */
export const DD_LEVER_ENTER_D = -0.2;
export const DD_LEVER_EXIT_D = -0.05;
/** 확대 상태의 122630 비중(나머지는 069500). */
export const DD_LEVER_EXPAND_LEVER_WEIGHT = 0.5;
/** 관문(수익형, 사용자 사전등록). */
export const DD_LEVER_G2_MDD_MARGIN_PP = 10.0;
export const DD_LEVER_G4_MAX_DELAY_DROP_PP = 1.0;
