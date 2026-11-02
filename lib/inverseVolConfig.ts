// 연구 IVA(변동성 역수 배분 R1 = 시도 260, R2 = 261, R3 = 262) 기준값. 사용자 지정 2026-11-02. 사전등록: docs/research/inverse-vol-allocation-prereg.md
// 구성요소(PE4·W3·LV1·L3)는 연구 ALLOC·CAPREC와 같은 코드·같은 순수익이다. 규칙·창·목표·구성은 시험 전에 고정했고 결과를 본 뒤 바꾸지 않는다.
export const IVA_PRIOR_TESTS = 259;
/** 변동성 창: 구성요소 일별 순수익률의 직전 N거래일 표본 표준편차. 이웃(게이트 D)은 120·500. */
export const IVA_VOL_WINDOW = 250;
export const IVA_WINDOW_NEIGHBORS = [120, 500] as const;
/** 이동 금액에 한 번 적용하는 비율(편도 평균 비용+슬리피지 가정, 사용자 지정). 정보용 민감도는 0.50%. */
export const IVA_MOVE_COST = 0.0025;
export const IVA_MOVE_COST_SENS = 0.005;
/** R2 계좌 변동성 목표: 직전 20거래일 포트폴리오 실현 변동성(연환산 √252), 배율 = min(1, 목표 ÷ σ), 실제 노출과 0.20 이상 차이 날 때만 다음 체결일에 조정. 이웃 목표 12%·18%. */
export const IVA_TARGET_VOL = 0.15;
export const IVA_TARGET_NEIGHBORS = [0.12, 0.18] as const;
export const IVA_TARGET_WINDOW = 20;
export const IVA_TARGET_BAND = 0.2;
/** 게이트 F 참고선: 1 − 0.05 ÷ (이번 사전등록의 후보 수). */
export const IVA_F_DENOMINATOR = 3;
/** 후보: comps = 변동성 역수 배분 대상, target = 계좌 변동성 목표(없으면 null). */
export const IVA_CANDS = {
  R1: { trial: 260, comps: ["PE4", "W3", "LV1", "L3"], target: null },
  R2: { trial: 261, comps: ["PE4", "W3", "LV1", "L3"], target: IVA_TARGET_VOL },
  R3: { trial: 262, comps: ["PE4", "W3", "LV1"], target: null },
} as const;
/** 게이트 H 참고선·재현 확인: 연구 ALLOC P2(4개 균등, 매일 재배분, 이동 금액의 0.25%) 전체 CAGR / MDD. */
export const IVA_P2_REF = { cagr: 13.08, mdd: 29.84 } as const;
/** 비중 분포 보고용 분위. */
export const IVA_W_QUANTILES = [0.05, 0.25, 0.5, 0.75, 0.95] as const;
