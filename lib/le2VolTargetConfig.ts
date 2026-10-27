// 연구 LV(LE2 + 변동성 목표화, 시도 223~225) 기준값. 사용자 지정 2026-10-27. 사전등록: docs/research/le2-voltarget-prereg.md
// 기저 전략은 연구 LE의 LE2(lib/momentumEnsembleConfig.ts LE_CANDS.LE2), 유니버스·비용·슬리피지·평가 시작·재진입 금지는 LE와 같다. 값은 결과를 본 뒤 조정하지 않는다.
export const LV_PRIOR_TESTS = 222;
/** 실현변동성 측정 창(거래일 수)과 연환산 일수(σ = 일수익률 표본표준편차 × √LV_ANNUAL_DAYS). */
export const LV_WINDOW = 20;
export const LV_ANNUAL_DAYS = 252;
/** 목표 배율 = min(1, σ_target ÷ σ)를 반올림하는 소수 자릿수. */
export const LV_ROUND_DP = 2;
/** 실제 배율(보유 종목 평균 비중 ÷ 슬롯 비중)과 목표 배율이 이 값 이상 차이 날 때만 다음 체결일에 조정한다. */
export const LV_BAND = 0.2;
/** 후보 → 목표 연변동성 σ_target. 이웃값(게이트 D)은 목표만 바꾼다. */
export const LV_CANDS = {
  LV1: { trial: 223, target: 0.2, neighbors: [0.15, 0.25] },
  LV2: { trial: 224, target: 0.25, neighbors: [0.2, 0.3] },
  LV3: { trial: 225, target: 0.3, neighbors: [0.25, 0.35] },
} as const;
/** 게이트 H: 기준선 = LE2(고정 스냅샷 재계산). 조건1 = CAGR ≥ 기준선 + 1%p, 조건2 = MDD ≤ 기준선 − 3%p 이고 CAGR ≥ 기준선 − 1%p, MDD 5%p 이상 개선 여부는 표시만. */
export const LV_H_CAGR_GAIN_PP = 1;
export const LV_H_MDD_GAIN_PP = 3;
export const LV_H_MDD_GAIN_STRONG_PP = 5;
export const LV_H_CAGR_FLOOR_PP = 1;
/** LE 시험에서 얻은 LE2 전체 CAGR / MDD(같은 스냅샷). 이번 실행에서 다시 계산해 일치를 확인한다. */
export const LV_LE2_REF = { cagr: 10.87, mdd: 55.36 } as const;
/** 배율이 이 값 미만이던 일수를 따로 센다(보고용). */
export const LV_LOW_MULT = 0.5;
