// 연구 WFR(워크포워드 랭킹 모델 M1 = 시도 248, M2 = 249, M3 = 250) 기준값. 사용자 지정 2026-10-28. 사전등록: docs/research/walkforward-ranker-prereg.md
// 값은 결과를 본 뒤 조정하지 않는다. 유니버스(K200P)·비용·슬리피지·상장폐지 청산은 기존 연구 상수를 그대로 쓰고, 이 파일은 특성·라벨·모델·매매 규칙만 담는다.
export const WFR_PRIOR_TESTS = 247;
/** 학습 데이터 시작, 평가(수익 집계) 시작, 첫 예측 연도(학습 2011~2013). */
export const WFR_TRAIN_FROM = "2011-01-04";
export const WFR_EVAL_FROM = "2014-01-02";
export const WFR_FIRST_PRED_YEAR = 2014;
/** 구간 표시 이름(평가 시작이 2014-01-02라 학습 구간 이름을 바꾼다). */
export const WFR_TRAIN_LABEL = "학습 2014~2016";

/** 특성(순서 고정). 모두 종가 d 기준, 종목 자신의 수정 종가 행 기준이며 매일 K200P 횡단면에서 [0,1] 순위로 정규화한다(결측은 그대로 둔다). */
export const WFR_PRICE_FEATURES = [
  "ret1", "ret5", "ret10", "ret20", "ret60", "ret120", "ret250", "mom12_1",
  "vol20", "vol60", "mdd60",
  "tvRatio", "logTv", "logMcap",
  "ma20Ratio", "ma60Ratio", "ma200Ratio", "high52Ratio",
  "clv5", "gap5",
  "rel20", "rel60", "sec20",
] as const;
/** 수급 특성(M2·M3). 일별 (순매수 금액 ÷ 거래대금)의 5·20일 합. 수급 캐시에는 외국인 열만 있어 기관은 쓸 수 없다(사전등록 한계 항목). */
export const WFR_FLOW_FEATURES = ["frgn5", "frgn20"] as const;
/** 수급 창 안에서 값이 있는 날 수가 창 길이의 이 비율(올림) 미만이면 결측(연구 foreign-flow-tilt·신호 스캔의 2/3 규칙). */
export const WFR_FLOW_MIN_RATIO = 2 / 3;
export const WFR_FLOW_WINDOWS = [5, 20] as const;
/** 52주 고가 창과 최소 행 수, 거래대금 평균 창. */
export const WFR_H52_ROWS = 252;
export const WFR_H52_MIN_ROWS = 200;
export const WFR_TV_WINDOW = 20;
/** 섹터 상대수익률: 같은 KSIC 2자리 업종의 K200P 소속 종목이 이 수 미만이면 결측. */
export const WFR_SECTOR_MIN_MEMBERS = 3;

/** 후보: 라벨 보유 기간 H(거래일)와 수급 특성 사용 여부. */
export const WFR_CANDS = {
  M1: { trial: 248, horizon: 20, flow: false },
  M2: { trial: 249, horizon: 20, flow: true },
  M3: { trial: 250, horizon: 5, flow: true },
} as const;
/** LightGBM 설정(조정 금지, 나머지는 기본값). */
export const WFR_LGB_PARAMS = {
  objective: "regression",
  num_leaves: 15,
  learning_rate: 0.05,
  n_estimators: 300,
  min_data_in_leaf: 200,
  feature_fraction: 0.8,
  bagging_fraction: 0.8,
  bagging_freq: 1,
  lambda_l2: 10,
  seed: 1,
} as const;
/** 게이트 D 이웃의 모델 시드, 라벨 셔플 대조의 시드(각 날짜 횡단면 안에서 라벨을 섞는다). */
export const WFR_NB_SEEDS = [2, 3] as const;
export const WFR_SHUFFLE_SEED = 20261028;

/** 매매 규칙: 상위 N위를 동일가중 보유, 순위가 keepRank 밖이면 매도(상위 N 밖~keepRank 안은 유지). 슬리피지(편도) 0.1%. */
export const WFR_PORT = { slots: 10, keepRank: 30, slip: 0.001, nbSlots: [7, 15], nbKeepRank: [20, 40] } as const;
/** 순위 점수 상위 몇 개까지 후보로 엔진에 넘기는가(보유 종목 때문에 건너뛰는 몫을 위한 여유). */
export const WFR_CAND_DEPTH = 40;
/** 게이트 F 참고선: 1 − 0.05 ÷ (이번 사전등록의 후보 수). */
export const WFR_F_DENOMINATOR = 3;
/** 참고 열(판정 아님): 연구 PEAD PE4(시도 238)의 기록값. 평가 시작이 2017-04-04라 이번 구간과 같지 않아 확인(2020~2021)·보류(2022~)만 비슷하다. */
export const WFR_PE4_REF = { confirm: "35.94 / 9.73 (2020~2021)", hold: "6.56 / 23.99", full: "14.21 / 23.99 (2017-04-04~)" } as const;
