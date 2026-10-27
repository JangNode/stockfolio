// 연구 L(시총 최상위 대형주 집중 + 추세 이탈 청산, 시도 208~210) 기준값. 사용자 지정 2026-10-27. 사전등록: docs/research/megacap-trend-prereg.md
/** 시도 번호는 207 다음부터(연구 C는 번호를 소진하지 않음). L1 = 208, L2 = 209, L3(통제군) = 210. */
export const L_PRIOR_TESTS = 207;
/**
 * entryRank: 시총 순위가 이 값 이내일 때 편입 후보, keepRank: 보유 종목은 순위가 이 값을 넘으면(밖이면) 매도, slots: 동시 보유 수(종목당 1/slots),
 * trend: 편입에 종가 > SMA, 청산에 종가 < SMA를 쓰는지, keepNeighbors: 게이트 D 이웃(매도 순위 한도, 하나씩만 바꿈), smaNeighbors는 trend 후보만 쓴다.
 */
export const L_CANDS = {
  L1: { trial: 208, entryRank: 5, keepRank: 10, slots: 5, trend: true, keepNeighbors: [8, 15] },
  L2: { trial: 209, entryRank: 10, keepRank: 20, slots: 10, trend: true, keepNeighbors: [15, 25] },
  L3: { trial: 210, entryRank: 5, keepRank: 10, slots: 5, trend: false, keepNeighbors: [8, 15] },
} as const;
/** 단순이동평균 기본 창과 이웃값(거래일). */
export const L_SMA = 200;
export const L_SMA_NEIGHBORS = [150, 250] as const;
/** 슬리피지(대형 0.1%). */
export const L_SLIPPAGE = 0.001;
/** 순위 계산에 담는 최대 시총 순위(매도 한도 이웃 25보다 크게). */
export const L_RANK_DEPTH = 30;
/** 평가 시작: 이 날짜 이후 첫 거래일을 판단일로 쓴다(200일선·250일선 계산 이력 때문에 2011-01). */
export const L_EVAL_AFTER = "2011-01-01";
