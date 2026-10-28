// 연구 D·T(거래대금·갭 신호 D1·D3·D5 = 시도 242~244, 추세 이탈 매매 T1~T3 = 시도 245~247) 기준값. 사용자 지정 2026-10-28. 사전등록: docs/research/volume-gap-trend-prereg.md
// 값은 결과를 본 뒤 조정하지 않는다. 유니버스·비용·평가 시작(L_EVAL_AFTER)·재진입 규칙의 나머지는 연구 L·PEAD의 상수를 그대로 쓴다.
export const VGT_PRIOR_TESTS = 241;
/** 동시 보유 최대 10종목 × 종목당 10%, 남는 몫은 현금. 슬리피지(편도) 0.1%. */
export const VGT_MAX_POS = 10;
export const VGT_SLIPPAGE = 0.001;
/** D 계열: 같은 종목 재진입은 보유 종료(매도 체결) 뒤 20거래일 금지. T 계열: 별도 금지 기간 없음(다음 상향 돌파 신호에서만 재진입). */
export const VGT_D_COOLDOWN_DAYS = 20;
export const VGT_T_COOLDOWN_DAYS = 0;
/** 거래대금 배수 = 당일 거래대금 ÷ 직전 N 거래일(당일 제외, 그 종목 행 기준) 평균 거래대금. */
export const VGT_VOL_WINDOW = 20;
/** 수급 부분집합(외국인 순매수 금액; Supabase에서 한 번만 읽어 Actions 캐시 research-flow-subset-20261028에 둔다). SHA-256은 구축 실행 뒤 기록한다. */
export const VGT_STUDY = {
  flowDir: ".research-flow",
  flowFile: "flow_frgn.parquet",
  flowCacheKey: "research-flow-subset-20261028",
  flowSha256: "e4eae79b4d09940a28d4ad5e33be506095715ea4031d8c60b5df9560ee19706d",
} as const;

/** D 계열 후보. volMult = 거래대금 배수 하한, retMin = 당일 수익률(전일 종가 대비) 하한, clvMin = 종가 위치 (종가−저가)/(고가−저가) 하한, gapMin = 시가 갭(시가 ÷ 전일 종가 − 1) 하한, maLen = 종가가 위여야 하는 이동평균 일수, hold = 보유 거래일(체결 후 N거래일 지나면 다음 거래일 종가 매도). */
export const VGT_D_CANDS = {
  D1: { trial: 242, kind: "spike", volMult: 3, retMin: 0.03, clvMin: 0.8, maLen: 60, hold: 10, needFlow: false, nbVolMult: [2, 4], nbRetMin: [0.02, 0.04], nbHold: [5, 15] },
  D3: { trial: 243, kind: "gap", volMult: 2, gapMin: 0.02, maLen: 200, hold: 10, needFlow: false, nbVolMult: [1.5, 3], nbGapMin: [0.015, 0.03], nbHold: [5, 15] },
  D5: { trial: 244, kind: "spike", volMult: 3, retMin: 0.03, clvMin: 0.8, maLen: 60, hold: 10, needFlow: true, nbVolMult: [2, 4], nbRetMin: [0.02, 0.04], nbHold: [5, 15] },
} as const;

/** T 계열 공통: 장기 우상향 = 종가 > L일 이동평균 ∧ L일 이동평균 > slope 거래일 전의 L일 이동평균. 후보가 남은 슬롯보다 많으면 직전 rankLookback 거래일 수익률(당일 종가 ÷ rankLookback 행 전 종가 − 1)이 큰 순. */
export const VGT_T_COMMON = { longMa: 200, slope: 20, rankLookback: 60, nbLongMa: [150, 250], nbSlope: [10, 30] } as const;
/** T 계열 후보: M = 상향 돌파·이탈 기준 이동평균 일수. */
export const VGT_T_CANDS = {
  T1: { trial: 245, ma: 5, nbMa: [4, 6] },
  T2: { trial: 246, ma: 10, nbMa: [8, 12] },
  T3: { trial: 247, ma: 20, nbMa: [15, 25] },
} as const;
/** 게이트 F 참고선: 1 − 0.05 ÷ (이번 사전등록의 후보 수). */
export const VGT_F_DENOMINATOR = 6;

/** 참고 열(판정 아님): 연구 PEAD 보유 단축 PE4(시도 238)의 기록값 — 평가 시작이 2017-04-04라 이번 학습(2011~2016)·전체 구간과는 구간이 달라 직접 비교할 수 없고, 확인(2020~2021)·보류(2022~)만 같은 구간이다. */
export const VGT_PE4_REF = { train: "13.65 / 8.66 (2017-04~2019)", confirm: "35.94 / 9.73", hold: "6.56 / 23.99", full: "14.21 / 23.99 (2017-04-04~)" } as const;
