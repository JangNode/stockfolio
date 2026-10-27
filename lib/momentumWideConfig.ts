// 연구 LW(앙상블 모멘텀 로테이션 종목 수 확대, 시도 229~231) 기준값. 사용자 지정 2026-10-27. 사전등록: docs/research/momentum-wide-prereg.md
// 점수(3·6·12-1개월 백분위 평균, lib/momentumEnsemble.ts)·편입 조건·재진입 금지(20거래일)·비용은 연구 LE와 같다(lib/momentumEnsembleConfig.ts LE_LEGS 등). 값은 결과를 본 뒤 조정하지 않는다.
export const LW_PRIOR_TESTS = 228;
/**
 * pool: 시총 순위 이 값 이내가 편입 풀(백분위의 모집단), slots: 동시 보유 수(= 편입 앙상블 순위 한도, 종목당 1/slots), keepRank: 풀 안 앙상블 순위가 이 값을 넘으면 매도,
 * keepCap: 시총 순위가 이 값을 넘으면 매도. 이웃값(게이트 D)은 하나씩만 바꾼다(보유 수를 바꾸면 편입 순위 한도와 종목당 비중이 함께 바뀌고 순위 매도 한도는 그대로).
 */
export const LW_CANDS = {
  LW1: { trial: 229, pool: 50, slots: 15, keepRank: 25, keepCap: 70, slotsNeighbors: [12, 18], keepNeighbors: [20, 30] },
  LW2: { trial: 230, pool: 100, slots: 20, keepRank: 35, keepCap: 130, slotsNeighbors: [16, 24], keepNeighbors: [30, 40] },
  LW3: { trial: 231, pool: 100, slots: 30, keepRank: 50, keepCap: 130, slotsNeighbors: [24, 36], keepNeighbors: [40, 60] },
} as const;
/** 시총 순위를 계산하는 최대 깊이(LW2·LW3 매도 한도 130보다 크거나 같아야 한다). */
export const LW_RANK_DEPTH = 130;
/**
 * 비교 기준선(같은 스냅샷으로 다시 계산): LE2(시총 30위 풀 상위 5개, 앙상블 10위·시총 40위 매도), LE3(시총 50위 풀 상위 10개, 앙상블 15위·시총 60위 매도). 연구 LE의 값.
 * 이번 실행에서 다시 계산해 일치를 확인한다.
 */
export const LW_BASES = {
  LE2: { pool: 30, slots: 5, keepRank: 10, keepCap: 40, ref: { cagr: 10.87, mdd: 55.36 } },
  LE3: { pool: 50, slots: 10, keepRank: 15, keepCap: 60, ref: { cagr: 6.09, mdd: 68.78 } },
} as const;
/** 게이트 H: LE3와 LE2 각각에 대해 조건1 = CAGR ≥ 기준선 + 1%p, 조건2 = MDD ≤ 기준선 − 3%p 이고 CAGR ≥ 기준선 − 1%p. 두 기준선 모두 O여야 H = O. MDD 5%p 이상 개선 여부는 표시만. */
export const LW_H_CAGR_GAIN_PP = 1;
export const LW_H_MDD_GAIN_PP = 3;
export const LW_H_MDD_GAIN_STRONG_PP = 5;
export const LW_H_CAGR_FLOOR_PP = 1;
