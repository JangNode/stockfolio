// 연구 RG(대형주 집중 + 시장 국면 필터, 시도 217~219) 기준값. 사용자 지정 2026-10-27. 사전등록: docs/research/megacap-regime-gate-prereg.md
// 국면 규칙·창·확인 일수(3일)는 운영 카드의 고정값(lib/marketRegimeConfig.ts, main 2b3791f에서 그대로 복사)을 쓰며 조정하지 않는다. 기저 전략의 상수는 연구 L·LM 설정을 그대로 쓴다.
export const RG_PRIOR_TESTS = 216;
/** 후보 → 기저 전략(필터 없는 기존 시험). 기저 기존 결과(전체 CAGR / MDD)는 같은 실행에서 다시 계산해 일치를 확인한다. */
export const RG_CANDS = {
  RG1: { trial: 217, base: "L3", ref: { cagr: 11.1, mdd: 51.63 } },
  RG2: { trial: 218, base: "LM2", ref: { cagr: 7.62, mdd: 55.45 } },
  RG3: { trial: 219, base: "LM3", ref: { cagr: 9.24, mdd: 57.59 } },
} as const;
/** 게이트 D: 국면 확인 일수 이웃(기본 3일, 하나씩만 바꿈). 기저 이웃은 후보별: RG1 순위 매도 한도 8·15, RG2 보유 수 4·6, RG3 룩백 90·180일. */
export const RG_CONFIRM_NEIGHBORS = [2, 5] as const;
export const RG1_KEEP_NEIGHBORS = [8, 15] as const;
/** 게이트 H(필터 가치): 필터 후보가 기저보다 CAGR +1%p 이상이거나, MDD가 3%p 이상(보고에 5%p 이상 여부도 표시) 낮으면서 CAGR이 기저 대비 −1%p 이내일 때 O. */
export const RG_H_CAGR_GAIN_PP = 1;
export const RG_H_MDD_GAIN_PP = 3;
export const RG_H_MDD_GAIN_STRONG_PP = 5;
export const RG_H_CAGR_FLOOR_PP = 1;
