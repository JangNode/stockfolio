// 연구 LM(대형주 내 모멘텀 로테이션, 시도 214~216) 기준값. 사용자 지정 2026-10-27. 사전등록: docs/research/megacap-momentum-prereg.md
// 유니버스·비용·슬리피지(L_SLIPPAGE)·평가 시작(L_EVAL_AFTER)은 연구 L의 상수(lib/megacapTrendConfig.ts), 재진입 금지는 연구 LS의 LS_COOLDOWN_DAYS를 그대로 쓴다.
export const LM_PRIOR_TESTS = 213;
/**
 * pool: 시총 순위 이 값 이내가 편입 풀, lookback: 모멘텀 룩백 거래일(수익률 = close[i−21] ÷ close[i−lookback] − 1), slots: 동시 보유 수(= 편입 모멘텀 순위 한도, 종목당 1/slots),
 * keepMom: 풀 안 모멘텀 순위가 이 값을 넘으면(밖이면) 매도, keepCap: 시총 순위가 이 값을 넘으면 매도, 이웃값(게이트 D)은 하나씩만 바꾼다.
 */
export const LM_CANDS = {
  LM1: { trial: 214, pool: 20, lookback: 252, slots: 3, keepMom: 8, keepCap: 30, slotsNeighbors: [2, 4], keepNeighbors: [6, 10], lookbackNeighbors: [] as number[] },
  LM2: { trial: 215, pool: 20, lookback: 252, slots: 5, keepMom: 10, keepCap: 30, slotsNeighbors: [4, 6], keepNeighbors: [8, 12], lookbackNeighbors: [] as number[] },
  LM3: { trial: 216, pool: 30, lookback: 126, slots: 5, keepMom: 12, keepCap: 40, slotsNeighbors: [] as number[], keepNeighbors: [10, 15], lookbackNeighbors: [90, 180] },
} as const;
/** 모멘텀에서 제외하는 최근 거래일 수(12-1, 6-1의 "-1"). */
export const LM_SKIP = 21;
/** 시총 순위를 계산하는 최대 깊이(LM3 매도 한도 40보다 크거나 같아야 한다). */
export const LM_RANK_DEPTH = 40;
