// 연구 A(우선주 괴리 회귀, 시도 204~205) 기준값. 사용자 지정 2026-10-26. 사전등록: docs/research/a-pref-spread-prereg.md
/** 괴리 z 점수의 직전 창(거래일, 당일 제외). 기본 250, 이웃값 200·300. */
export const A_Z_WINDOW = 250;
export const A_Z_WINDOW_NEIGHBORS = [200, 300] as const;
/** z 점수 계산에 필요한 최소 체결일 비율(창 안에서 두 종목이 모두 체결된 날). */
export const A_Z_MIN_OBS_RATIO = 0.9;
/** 진입 z (A1 = 204, A2 = 205)와 A1 이웃값, 청산 z, 손절(매수가 대비 비율, z). */
export const A_ENTRY_Z = { A1: -2.0, A2: -1.5 } as const;
export const A_ENTRY_Z_NEIGHBORS = { A1: [-1.75, -2.25], A2: [-1.25, -1.75] } as const;
export const A_EXIT_Z = 0;
export const A_STOP_PRICE_RET = -0.2;
export const A_STOP_Z = -4;
/** 진입 자격: 우선주 20일 평균 거래대금(원) 하한, 직전 250거래일 중 체결 없는 날 비율 상한, 같은 종목 재진입 금지 거래일. */
export const A_MIN_AVG_TV_WON = 200_000_000;
export const A_NO_TRADE_WINDOW = 250;
export const A_MAX_NO_TRADE_RATIO = 0.1;
export const A_REENTRY_BAN_DAYS = 20;
/** 동시 보유 종목 수 상한, 슬리피지(우선주도 소형과 같은 0.2%). */
export const A_MAX_POS = 5;
export const A_SLIPPAGE = 0.002;
/** 게이트 G(진입 건수 하한)와 사전 점검의 실행 불가 기준(이론상 진입 기회 상한이 이 값 미만이면 해당 후보 실행 불가·번호 미소진). */
export const A_MIN_ENTRIES = 100;
/** 시도 번호. */
export const A_TRIAL_NO = { A1: 204, A2: 205 } as const;
