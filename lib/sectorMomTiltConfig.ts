// 대형주 업종 모멘텀 틸트 v2(scripts/research-sector-mom-tilt.ts, research/sector-mom-tilt-prereg.md) 기준값. 모두 사용자 사전등록(2026-10-21).

/** 첫 신호 월(월 마지막 거래일), 학습 시작. */
export const SMT_FIRST_SIGNAL_MONTH = "2010-06";
export const SMT_LEARN = { from: "2010-07-01", to: "2016-12-31" } as const;
/** 모멘텀 기간(개월, 최근 1개월 제외), 상·하위 업종 수, 배수(상위, 하위). */
export const SMT_LOOKBACK_MONTHS = 6;
export const SMT_SKIP_MONTHS = 1;
export const SMT_TOP_K = 3;
export const SMT_MULT_TOP = 1.5;
export const SMT_MULT_BOTTOM = 0.5;
/** 업종 최소 유효 종목 수(미만이면 중립). */
export const SMT_MIN_SECTOR_STOCKS = 2;
/** 0단계: 연도 평균 시총 기준 업종 분류 보유 비율 하한(%). */
export const SMT_STAGE0_MIN_MCAP_COVERAGE_PCT = 90;
/** 참고 기준: G1 CAGR ≥ POOL + 1.0%p, G3 MDD ≤ POOL MDD + 5.0%p, G4 지연 하락 ≤ 1.0%p. */
export const SMT_G1_MARGIN_PP = 1.0;
export const SMT_G3_MDD_MARGIN_PP = 5.0;
export const SMT_G4_MAX_DELAY_DROP_PP = 1.0;
/** R1 주변 값. */
export const SMT_R1_LOOKBACKS = [3, 12] as const;
export const SMT_R1_TOP_KS = [2, 4] as const;
export const SMT_R1_MULTS = [[1.3, 0.7], [2.0, 0.0]] as const;
/** R3 무작위 비교. */
export const SMT_R3_DRAWS = 1000;
export const SMT_R3_SEED = 20261021;
/** 월 회전율 환산(연 12회). */
export const SMT_MONTHS_PER_YEAR = 12;
