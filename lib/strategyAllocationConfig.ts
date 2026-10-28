// 연구 ALLOC(전략 배분 포트폴리오 P1 = 시도 254, P2 = 255, P3 = 256) 기준값. 사용자 지정 2026-10-28. 사전등록: docs/research/strategy-allocation-prereg.md
// 구성요소는 이미 개별로 탈락한 전략 PE4·W3·LV1·L3의 일별 순수익(비용 반영 후)이다. 비율·구성요소·비용은 결과를 본 뒤 바꾸지 않는다.
export const ALLOC_PRIOR_TESTS = 253;
export const ALLOC_COMP_IDS = ["PE4", "W3", "LV1", "L3"] as const;
export type AllocCompId = (typeof ALLOC_COMP_IDS)[number];
/** 구성요소 재현 기준(각 전략의 원래 시험 기록, 원래 평가 시작 기준 전체 구간 CAGR / MDD). 소수 둘째 자리까지 같아야 한다. 다르면 중단한다. */
export const ALLOC_REPRO: Record<AllocCompId, { cagr: number; mdd: number }> = {
  PE4: { cagr: 14.21, mdd: 23.99 },
  W3: { cagr: 5.77, mdd: 47.04 },
  LV1: { cagr: 6.95, mdd: 46.46 },
  L3: { cagr: 11.05, mdd: 51.63 },
};
/** 리밸런싱 비용: 이동 금액(과대 구성요소에서 빠져 과소 구성요소로 옮겨지는 금액)에 한 번 적용하는 비율. 편도 평균 비용+슬리피지 가정(사용자 지정). */
export const ALLOC_REBAL_COST = 0.0025;
/** 정보용(판정 불사용): 같은 이동 금액에 0.50%(편도 0.25%를 매도·매수 양쪽에 적용한 보수적 해석)를 적용한 민감도. */
export const ALLOC_REBAL_COST_SENS = 0.005;
/** 게이트 F 참고선: 1 − 0.05 ÷ (이번 사전등록의 후보 수). */
export const ALLOC_F_DENOMINATOR = 3;
/** 후보 → 구성요소와 목표 비중. 이웃(게이트 D) 비율은 사전등록 표를 그대로 옮겼다: P1 = 사용자 예시(한 구성요소 40%, 나머지 30%), P2 = 한 구성요소 35%(나머지 65% 균등) 또는 15%(나머지 85% 균등), P3 = 60/40·40/60. 그리고 구성요소 하나 제외(나머지 균등). */
type Wt = Partial<Record<AllocCompId, number>>;
export const ALLOC_CANDS: Record<"P1" | "P2" | "P3", { trial: number; weights: Wt; neighbors: { label: string; weights: Wt }[] }> = {
  P1: {
    trial: 254, weights: { PE4: 1 / 3, W3: 1 / 3, LV1: 1 / 3 },
    neighbors: [
      { label: "PE4 40 / W3 30 / LV1 30", weights: { PE4: 0.4, W3: 0.3, LV1: 0.3 } },
      { label: "PE4 30 / W3 40 / LV1 30", weights: { PE4: 0.3, W3: 0.4, LV1: 0.3 } },
      { label: "PE4 30 / W3 30 / LV1 40", weights: { PE4: 0.3, W3: 0.3, LV1: 0.4 } },
      { label: "PE4 제외 (W3 50 / LV1 50)", weights: { W3: 0.5, LV1: 0.5 } },
      { label: "W3 제외 (PE4 50 / LV1 50)", weights: { PE4: 0.5, LV1: 0.5 } },
      { label: "LV1 제외 (PE4 50 / W3 50)", weights: { PE4: 0.5, W3: 0.5 } },
    ],
  },
  P2: {
    trial: 255, weights: { PE4: 0.25, W3: 0.25, LV1: 0.25, L3: 0.25 },
    neighbors: [
      { label: "PE4 35 (나머지 21.67)", weights: { PE4: 0.35, W3: 0.65 / 3, LV1: 0.65 / 3, L3: 0.65 / 3 } },
      { label: "W3 35 (나머지 21.67)", weights: { PE4: 0.65 / 3, W3: 0.35, LV1: 0.65 / 3, L3: 0.65 / 3 } },
      { label: "LV1 35 (나머지 21.67)", weights: { PE4: 0.65 / 3, W3: 0.65 / 3, LV1: 0.35, L3: 0.65 / 3 } },
      { label: "L3 35 (나머지 21.67)", weights: { PE4: 0.65 / 3, W3: 0.65 / 3, LV1: 0.65 / 3, L3: 0.35 } },
      { label: "PE4 15 (나머지 28.33)", weights: { PE4: 0.15, W3: 0.85 / 3, LV1: 0.85 / 3, L3: 0.85 / 3 } },
      { label: "W3 15 (나머지 28.33)", weights: { PE4: 0.85 / 3, W3: 0.15, LV1: 0.85 / 3, L3: 0.85 / 3 } },
      { label: "LV1 15 (나머지 28.33)", weights: { PE4: 0.85 / 3, W3: 0.85 / 3, LV1: 0.15, L3: 0.85 / 3 } },
      { label: "L3 15 (나머지 28.33)", weights: { PE4: 0.85 / 3, W3: 0.85 / 3, LV1: 0.85 / 3, L3: 0.15 } },
      { label: "PE4 제외 (W3·LV1·L3 각 1/3)", weights: { W3: 1 / 3, LV1: 1 / 3, L3: 1 / 3 } },
      { label: "W3 제외 (PE4·LV1·L3 각 1/3)", weights: { PE4: 1 / 3, LV1: 1 / 3, L3: 1 / 3 } },
      { label: "LV1 제외 (PE4·W3·L3 각 1/3)", weights: { PE4: 1 / 3, W3: 1 / 3, L3: 1 / 3 } },
      { label: "L3 제외 (PE4·W3·LV1 각 1/3)", weights: { PE4: 1 / 3, W3: 1 / 3, LV1: 1 / 3 } },
    ],
  },
  P3: {
    trial: 256, weights: { PE4: 0.5, W3: 0.5 },
    neighbors: [
      { label: "PE4 60 / W3 40", weights: { PE4: 0.6, W3: 0.4 } },
      { label: "PE4 40 / W3 60", weights: { PE4: 0.4, W3: 0.6 } },
      { label: "W3 제외 (PE4 단독)", weights: { PE4: 1 } },
      { label: "PE4 제외 (W3 단독)", weights: { W3: 1 } },
    ],
  },
};
/** 구성요소 일별 순수익(원래 평가 시작부터, 비용 반영 후) 저장 파일의 SHA-256. 사전 점검 실행(ALLOC_MODE=repro)이 기록한 뒤 사전등록에 적고 여기에 옮긴다. null이면 대조하지 않는다. */
export const ALLOC_SERIES_SHA: Record<AllocCompId, string> | null = null;
