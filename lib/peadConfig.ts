// 연구 PEAD(실적 공시 직후 드리프트, 시도 235~) 기준값. 사용자 지정 2026-10-28. 사전등록: docs/research/pead-prereg.md
// 1단계(가능성 점검, 시험 아님)와 2단계(후보 정의)가 같이 쓴다. 값은 결과를 본 뒤 조정하지 않는다.
export const PEAD_PRIOR_TESTS = 234;
/** 평가 구간 시작(수익률 집계 시작 판단일): 연구 LE 이후와 같다. */
export const PEAD_EVAL_FROM = "2011-01-03";
/** 커버리지 판정 기준(%) — 세 단계를 모두 보고만 하고, 결과를 본 뒤 바꾸지 않는다. */
export const PEAD_COVERAGE_LEVELS = [70, 60, 50] as const;
/** 동시 보유 최대, 종목당 비중은 1/PEAD_MAX_POS, 같은 종목 재진입 금지(거래일). */
export const PEAD_MAX_POS = 10;
export const PEAD_COOLDOWN_DAYS = 20;
/** 후보 → 유니버스, 영업이익 전년 동기 대비 증가율 하한, 고정 보유 거래일 수 N(체결 후 N거래일 보유 뒤 다음 거래일 종가 매도). 이웃(게이트 D) = 증가율 ±10%p, N ±20거래일. */
export const PEAD_CANDS = {
  PE1: { universe: "K200P", growth: 0.3, hold: 40 },
  PE2: { universe: "SMALL", growth: 0.3, hold: 40 },
  PE3: { universe: "K200P", growth: 0.5, hold: 60 },
} as const;
/** 가능성 점검에서 연도별로 세는 증가율 하한들(보고용). */
export const PEAD_COUNT_GROWTHS = [0.2, 0.3, 0.4, 0.5, 0.6] as const;
