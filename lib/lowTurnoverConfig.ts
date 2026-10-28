// 연구 LTR(저회전 매매 규칙 W1 = 시도 251, W2 = 252, W3 = 253) 기준값. 사용자 지정 2026-10-28. 사전등록: docs/research/low-turnover-rules-prereg.md
// 점수·특성·모델은 연구 WFR(M2·M3)의 저장된 예측 점수를 그대로 재사용하고, 매매 규칙(최소 보유일·매도 순위)만 바꾼다. 값은 결과를 본 뒤 조정하지 않는다.
export const LTR_PRIOR_TESTS = 250;
/** 저장된 예측 점수가 든 Actions 캐시 키(연구 WFR 정식 실행 run 40616510084가 저장). */
export const LTR_SCORES_CACHE_KEY = "wfr-scores-40616510084";
/** 후보: score = 쓰는 WFR 점수 변형, minHold = 최소 보유 거래일, sellRank = 매도 순위(이 순위 초과여야 매도), nb* = 게이트 D 이웃(하나씩 바꿈). */
export const LTR_CANDS = {
  W1: { trial: 251, score: "M2", minHold: 20, sellRank: 60, nbSellRank: [40, 80], nbMinHold: [10, 30] },
  W2: { trial: 252, score: "M2", minHold: 20, sellRank: 100, nbSellRank: [70, 150], nbMinHold: [10, 30] },
  W3: { trial: 253, score: "M3", minHold: 10, sellRank: 100, nbSellRank: [70, 150], nbMinHold: [5, 15] },
} as const;
/** 진입·크기: 상위 entryTop위 안 신규 종목만 편입(없으면 현금), 최대 slots종목 × 1/slots, 슬리피지(편도) 0.1%. */
export const LTR_PORT = { slots: 10, entryTop: 10, slip: 0.001 } as const;
/** 재현 확인용 기준(WFR 정식 실행 기록): 최소 보유일 0·매도 순위 30·진입 후보 깊이 40의 M2·M3 전체 구간 CAGR / MDD. 소수 둘째 자리까지 같아야 한다. */
export const LTR_REPRO = { M2: { cagr: -3.76, mdd: 69.54, mix: [6.3, 40.12] }, M3: { cagr: -0.09, mdd: 52.6, mix: [11.17, 25.49] } } as const;
export const LTR_REPRO_RULE = { slots: 10, sellRank: 30, minHold: 0, depth: 40 } as const;
/** 게이트 F 참고선: 1 − 0.05 ÷ (이번 사전등록의 후보 수). */
export const LTR_F_DENOMINATOR = 3;
/** 스타일 쏠림 진단: 보유 종목의 횡단면 순위 정규화 특성(0 = 그날 최소, 1 = 최대). */
export const LTR_STYLE_FEATURES = ["logMcap", "vol60", "logTv"] as const;
