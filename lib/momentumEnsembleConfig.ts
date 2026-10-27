// 연구 LE(모멘텀 앙상블 로테이션, 시도 220~222) 기준값. 사용자 지정 2026-10-27. 사전등록: docs/research/momentum-ensemble-prereg.md
// 유니버스·비용·슬리피지(L_SLIPPAGE)·평가 시작(L_EVAL_AFTER)은 연구 L의 상수(lib/megacapTrendConfig.ts), 재진입 금지(20거래일)는 연구 LS의 LS_COOLDOWN_DAYS를 그대로 쓴다.
export const LE_PRIOR_TESTS = 219;
/**
 * 앙상블 점수 = 세 구간 수익률의 풀 내 백분위 순위를 단순 평균한 값. 수익률 = close[i−skip] ÷ close[i−lookback] − 1 (3개월 63−5, 6개월 126−5, 12−1개월 252−21).
 * 한 구간이라도 계산할 수 없으면 그날 그 종목은 후보에서 제외한다. 조정하지 않는다.
 */
export const LE_LEGS = [
  { name: "3개월", lookback: 63, skip: 5 },
  { name: "6개월", lookback: 126, skip: 5 },
  { name: "12-1개월", lookback: 252, skip: 21 },
] as const;
/** 편입 금지 판정에 쓰는 개별 수익률 = LE_LEGS의 이 번째(12-1개월). 이 값이 0 이하이면(엄격) 편입하지 않는다(현금 허용). */
export const LE_ENTRY_LEG = 2;
/**
 * pool: 시총 순위 이 값 이내가 편입 풀(백분위의 모집단), slots: 동시 보유 수(= 편입 앙상블 순위 한도, 종목당 1/slots), keepRank: 풀 안 앙상블 순위가 이 값을 넘으면 매도,
 * keepCap: 시총 순위가 이 값을 넘으면 매도. 이웃값(게이트 D)은 하나씩만 바꾼다.
 */
export const LE_CANDS = {
  LE1: { trial: 220, pool: 30, slots: 10, keepRank: 15, keepCap: 40, slotsNeighbors: [8, 12], keepNeighbors: [12, 20] },
  LE2: { trial: 221, pool: 30, slots: 5, keepRank: 10, keepCap: 40, slotsNeighbors: [4, 6], keepNeighbors: [8, 12] },
  LE3: { trial: 222, pool: 50, slots: 10, keepRank: 15, keepCap: 60, slotsNeighbors: [8, 12], keepNeighbors: [12, 20] },
} as const;
/** 시총 순위를 계산하는 최대 깊이(LE3 매도 한도 60보다 크거나 같아야 한다). */
export const LE_RANK_DEPTH = 60;
/**
 * 게이트 H: 기준선 = 같은 데이터(고정 스냅샷)로 다시 계산한 LM2와 L3 각각(둘 다 만족해야 O). 한 기준선에 대해
 * 조건1 = 후보 CAGR ≥ 기준선 + 1%p, 조건2 = 후보 MDD ≤ 기준선 − 3%p 이고 후보 CAGR ≥ 기준선 − 1%p. 둘 중 하나면 그 기준선에 대해 O. MDD 5%p 이상 개선 여부는 표시만 한다.
 */
export const LE_H_CAGR_GAIN_PP = 1;
export const LE_H_MDD_GAIN_PP = 3;
export const LE_H_MDD_GAIN_STRONG_PP = 5;
export const LE_H_CAGR_FLOOR_PP = 1;
/** 데이터 종료일이 다른 이전 실행의 기저 전체 CAGR / MDD(데이터 종료일 차이 기록용): LM 시험(2026-10-16 이전 종료일)의 값과 RG 시험(2026-10-26, 스냅샷 이전 캐시)의 재계산 값. */
export const LE_PREV_BASE = {
  L3: { lm: { cagr: 11.1, mdd: 51.63 }, rg: { cagr: 11.05, mdd: 51.63 } },
  LM2: { lm: { cagr: 7.62, mdd: 55.45 }, rg: { cagr: 7.57, mdd: 55.45 } },
  LM3: { lm: { cagr: 9.24, mdd: 57.59 }, rg: { cagr: 9.19, mdd: 57.59 } },
} as const;
