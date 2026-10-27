// 연구 LS(대형주 집중 + 고점 대비 trailing stop, 시도 211~213) 기준값. 사용자 지정 2026-10-27. 사전등록: docs/research/megacap-trailing-prereg.md
// 유니버스·비용·슬리피지(L_SLIPPAGE)·순위 깊이·평가 시작은 연구 L의 상수(lib/megacapTrendConfig.ts)를 그대로 쓴다. 모든 후보는 200일선 규칙 없음, 시총 순위로만 편입.
export const LS_PRIOR_TESTS = 210;
/**
 * entryRank: 시총 순위가 이 값 이내일 때 편입 후보, keepRank: 보유 종목은 순위가 이 값을 넘으면(밖이면) 매도, slots: 동시 보유 수(종목당 1/slots),
 * stop: 진입 후 최고 종가 대비 이 비율 이상 하락해 마감하면 매도(종가 ≤ 최고 종가 × (1 − stop)), stopNeighbors·keepNeighbors: 게이트 D 이웃(하나씩만 바꿈).
 */
export const LS_CANDS = {
  LS1: { trial: 211, entryRank: 5, keepRank: 10, slots: 5, stop: 0.2, stopNeighbors: [0.15, 0.25], keepNeighbors: [8, 15] },
  LS2: { trial: 212, entryRank: 5, keepRank: 10, slots: 5, stop: 0.3, stopNeighbors: [0.25, 0.35], keepNeighbors: [8, 15] },
  LS3: { trial: 213, entryRank: 10, keepRank: 20, slots: 10, stop: 0.25, stopNeighbors: [0.2, 0.3], keepNeighbors: [15, 25] },
} as const;
/** 매도 후 재진입 금지 거래일(어떤 매도든 체결일부터 이 값 이상 지난 판단일부터 재진입 가능). */
export const LS_COOLDOWN_DAYS = 20;
/** 게이트 H 기준선 L3(연구 L, 추세·손절 규칙 없는 대형주 집중)의 기존 전체 결과 — 같은 실행에서 L3를 다시 계산해 일치를 확인한다(소수 둘째 자리). */
export const LS_REF_L3 = { cagr: 11.1, mdd: 51.63 } as const;
