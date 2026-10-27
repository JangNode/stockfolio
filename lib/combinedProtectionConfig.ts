// 연구 LC(변동성 목표화 + 절대 모멘텀 청산 결합, 시도 232~234) 기준값. 사용자 지정 2026-10-27. 사전등록: docs/research/combined-protection-prereg.md
// 변동성 목표화는 lib/le2VolTargetConfig.ts(LV), 절대 모멘텀 청산은 lib/le2AbsMomentumConfig.ts의 AM2 정의를 그대로 쓴다. 값은 결과를 본 뒤 조정하지 않는다.
export const LC_PRIOR_TESTS = 231;
/** 후보 → 기저 전략(LE2 = lib/momentumEnsembleConfig.ts, L3 = lib/megacapTrendConfig.ts), 목표 연변동성, 이웃값(게이트 D). 이웃의 "구성" 쪽은 LC1·LC3 = AM2 룩백 세트 두 개, LC2 = L3 순위 한도 8·15. */
export const LC_CANDS = {
  LC1: { trial: 232, base: "LE2", target: 0.25, sigmaNeighbors: [0.2, 0.3] },
  LC2: { trial: 233, base: "L3", target: 0.25, sigmaNeighbors: [0.2, 0.3] },
  LC3: { trial: 234, base: "LE2", target: 0.2, sigmaNeighbors: [0.15, 0.25] },
} as const;
/** LC2의 순위 한도 이웃값(L3 청산 순위 한도 8·15; lib/megacapTrendConfig.ts L_CANDS.L3.keepNeighbors와 같다). */
export const LC2_KEEP_RANK_NEIGHBORS = [8, 15] as const;
/** 게이트 H에서 후보 옆에 같이 보이는 "변동성 목표화 단독" 비교(가장 가까운 σ): LC1·LC2 → LV2(σ25%), LC3 → LV1(σ20%). LC2의 기저는 L3이지만 L3 기반 LV 시험은 없어 LE2 기반 LV2를 가장 가까운 것으로 보인다. */
export const LC_LV_NEAREST = { LC1: "LV2", LC2: "LV2", LC3: "LV1" } as const;
/** 이전 시험에서 얻은 값(같은 스냅샷). 이번 실행에서 다시 계산해 일치를 확인한다(불일치는 보고만, 중단하지 않는다). */
export const LC_REFS = { LE2: { cagr: 10.87, mdd: 55.36 }, L3: { cagr: 11.05, mdd: 51.63 }, LV1: { cagr: 6.95, mdd: 46.46 }, LV2: { cagr: 7.95, mdd: 50.61 } } as const;
/**
 * 명세 공백 보완(결과를 보기 전에 사전등록): LC2의 기저 L3은 재진입 금지가 없고(쿨다운 0) 12-1개월 편입 필터도 없다. 이 상태에서 절대 모멘텀으로 청산하면
 * 시총 상위 5위 안에 남아 있는 같은 종목을 바로 다시 사서 매일 사고파는 반복이 되므로, LC2에 한해 절대 모멘텀 청산 종목은 이 거래일 수 동안 재편입하지 않는다
 * (LE2 계열의 재진입 금지 20거래일과 같은 값, lib/megacapTrailingConfig.ts LS_COOLDOWN_DAYS). L3의 다른 청산(시총 순위 밖)에는 적용하지 않는다.
 */
export const LC2_AM_REENTRY_BAN_DAYS = 20;
/** 하락 구간(보고용): 이름, 시작, 끝, 장치 작동일 조회 시작(맥락). */
export const LC_DOWNTURNS = [
  ["2020-03", "2020-03-01", "2020-03-31", "2020-01-02"],
  ["2022", "2022-01-01", "2022-12-31", "2021-11-01"],
  ["2026-06~07", "2026-06-01", "2026-07-31", "2026-04-01"],
  ["2026-10", "2026-10-01", "2026-10-26", "2026-08-03"],
] as const;
