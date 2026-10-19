// 소형주 저변동성·영업이익 전략 연구(scripts/research-smallcap-lowvol.ts, research/smallcap-lowvol-prereg.md) 기준값. 모두 사용자 사전등록(2026-10-19).
// SMALL 유니버스 기준·SMALL 슬리피지는 lib/signalScanConfig.ts(SCAN_SMALL_*), 분기 신선도는 SCAN_QUARTER_FRESH_DAYS를 쓴다.

/** VOL 창(거래일)과 R1 주변 값. 창 안 주가 있는 날의 최소 비율은 2/3(60일 중 40일). */
export const LV_VOL_DAYS = 60;
export const LV_R1_VOL_DAYS = [40, 90] as const;
export const LV_MIN_PRICE_DAY_RATIO = 2 / 3;
/** M2 보유 종목 수, M3 최소 종목 수(미만이면 M1 선정으로 대체). */
export const LV_M2_COUNT = 50;
export const LV_M3_MIN_COUNT = 30;
/** 분기 리밸런싱 월(월 마지막 거래일 신호), 첫 신호 월. */
export const LV_QUARTER_MONTHS = [3, 6, 9, 12] as const;
export const LV_FIRST_SIGNAL_MONTH = "2010-03";
/** 기간(사전등록). 홀드아웃 종료는 달력 마지막 거래일. */
export const LV_LEARN = { from: "2010-04-01", to: "2016-12-31" } as const;
export const LV_CONFIRM = { from: "2017-01-01", to: "2021-12-31" } as const;
export const LV_HOLDOUT_FROM = "2022-01-01";
/** 관문(사전등록). */
export const LV_G1_CAGR_MARGIN_PP = 2.0;
export const LV_G3_MDD_MARGIN_PP = 10.0;
export const LV_G4_MAX_DELAY_DROP_PP = 1.0;
/** R1·R2 기준(SEW 전 기간 CAGR + 2.0%p)과 R3 무작위 비교. */
export const LV_R_CAGR_MARGIN_PP = 2.0;
export const LV_R3_DRAWS = 1000;
export const LV_R3_SEED = 20261020;
export const LV_R3_TOP_FRACTION = 0.05;
/** 분기당 거래 횟수(분기 평균 회전율 환산). */
export const LV_QUARTERS_PER_YEAR = 4;
