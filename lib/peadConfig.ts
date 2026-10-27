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
  PE1: { trial: 235, universe: "K200P", growth: 0.3, hold: 40 },
  PE2: { trial: 236, universe: "SMALL", growth: 0.3, hold: 40 },
  PE3: { trial: 237, universe: "K200P", growth: 0.5, hold: 60 },
} as const;
/** 가능성 점검에서 연도별로 세는 증가율 하한들(보고용). */
export const PEAD_COUNT_GROWTHS = [0.2, 0.3, 0.4, 0.5, 0.6] as const;

// ---- 2단계(시도 235~237) 승인 결정 2026-10-28 (사용자, 결과 보기 전 확정). 사전등록: docs/research/pead-prereg.md 7절 ----
/** 수익 집계 시작 판단일(수익률은 다음 거래일부터)과 구간: 학습 2017-04-03~2019-12-31 / 확인 2020-01-01~2021-12-31 / 보류 2022-01-01~. */
export const PEAD_RUN_START = "2017-04-03";
export const PEAD_WINDOWS: readonly (readonly [string, string, string])[] = [["학습 2017-04~2019", "2017-04-04", "2019-12-31"], ["확인 2020~2021", "2020-01-01", "2021-12-31"], ["보류 2022~", "2022-01-01", "9999-12-31"]];
/** 슬리피지(편도 비율): K200P 0.1%, SMALL 0.2%(연구 R의 R_SMALL_SLIPPAGE와 같다). */
export const PEAD_SLIPPAGE = { K200P: 0.001, SMALL: 0.002 } as const;
/** 게이트 D 이웃: 증가율 ±10%p, 보유 N ±20거래일. */
export const PEAD_G_NEIGHBOR = 0.1;
export const PEAD_N_NEIGHBOR = 20;
/** 게이트 H(기준선 = 069500): 조건1 = CAGR ≥ 기준선 + 1%p, 조건2 = MDD ≤ 기준선 − 3%p 이고 CAGR ≥ 기준선 − 1%p. MDD 5%p 이상 개선 여부는 표시만. */
export const PEAD_H_CAGR_GAIN_PP = 1;
export const PEAD_H_MDD_GAIN_PP = 3;
export const PEAD_H_MDD_GAIN_STRONG_PP = 5;
export const PEAD_H_CAGR_FLOOR_PP = 1;
/** 정기보고서 제출 기한(월-일): 사업보고서 3/31, 1분기 5/15, 반기 8/14, 3분기 11/14. 보고용 "공시 시즌" = 기한 20일 전 ~ 기한 10일 후(달력일). 거래 규칙에는 쓰지 않는다. */
export const PEAD_DEADLINES = ["03-31", "05-15", "08-14", "11-14"] as const;
export const PEAD_SEASON_BEFORE_DAYS = 20;
export const PEAD_SEASON_AFTER_DAYS = 10;
/** 하락 구간(보고용): 이름, 시작, 끝. */
export const PEAD_DOWNTURNS = [["2020-03", "2020-03-01", "2020-03-31"], ["2022", "2022-01-01", "2022-12-31"], ["2026-06~07", "2026-06-01", "2026-07-31"], ["2026-10", "2026-10-01", "2026-10-26"]] as const;

// ---- 연구 PEAD 보유 단축 + 하락장 진입 차단(PE4~PE6, 시도 238~240). 사용자 지정 2026-10-28. 사전등록: docs/research/pead-short-hold-prereg.md ----
// 이벤트 정의·유니버스·구간·비용·슬롯은 위 PEAD(PE1~PE3)와 같다. ma = 신호 확정일 069500 종가가 ma거래일 이동평균 아래이면 그날 신규 진입 금지(보유 종목은 그대로).
export const PEAD_SHORT_PRIOR_TESTS = 237;
export const PEAD_SHORT_CANDS = {
  PE4: { trial: 238, universe: "K200P", growth: 0.3, hold: 20, ma: 0, growthNeighbors: [0.2, 0.4], holdNeighbors: [10, 30], maNeighbors: [] },
  PE5: { trial: 239, universe: "K200P", growth: 0.3, hold: 20, ma: 200, growthNeighbors: [0.2, 0.4], holdNeighbors: [10, 30], maNeighbors: [150, 250] },
  PE6: { trial: 240, universe: "K200P", growth: 0.5, hold: 20, ma: 0, growthNeighbors: [0.4, 0.6], holdNeighbors: [10, 30], maNeighbors: [] },
} as const;
/** 비교 열 PE1(연구 PEAD, K200P 증가율 ≥ 30% N = 40)과 그 이전 시험 값(같은 스냅샷·기준선에서 다시 계산해 일치를 확인한다). */
export const PEAD_PE1_REF = { growth: 0.3, hold: 40, cagr: 10.32, mdd: 48.66 } as const;
/** 삼성전기(009150)의 2026-03 진입 거래를 069500으로 바꿔 보는 보고용 점검(PEAD에서 단일 거래 의존이 컸다). */
export const PEAD_SEMCO = { code: "009150", entryMonth: "2026-03" } as const;
