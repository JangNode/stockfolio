// VKOSPI 후속(1단계 확인 점검 + 2단계 DS12/시도 286) 기준값. 사용자 지정 2026-11-05. 사전등록: docs/research/vkospi-confirm-prereg.md (1단계 값을 열기 전에 커밋)
// 값은 시험 전에 고정했고 결과를 본 뒤 바꾸지 않는다. 1단계 결과를 보고 2단계 정의를 바꾸지 않는다.

// ---- 1단계: 스캔 후보의 확인 구간 재현 점검(시험 아님, 시험 번호 285 유지) ----
/** 확인 구간(신호일 기준)과 보류 구간(재현일 때만 한 번 열람). 보류 구간 끝 = 고정 스냅샷 끝. */
export const VC_CONFIRM_FROM = "2017-01-01";
export const VC_CONFIRM_TO = "2021-12-31";
export const VC_HOLDOUT_FROM = "2022-01-01";
export const VC_HOLDOUT_TO = "2026-10-26";
/** 재현 기준: 학습 구간과 같은 부호, Newey-West |t| 이상, 비용 차감 순차이 > 0. */
export const VC_MIN_ABS_T = 2.0;
/** 069500의 V1 또는 V4가 세 예측 기간 중 이 개수 이상에서 재현 기준을 만족하면 "재현". */
export const VC_MIN_H_PASS = 2;
/** 점검 대상 신호(스캔 사전등록 1f3ab5a·추기 c8dd304의 V1 수준, V4 급등일)와 대상. DS6 V4 H=21은 보고만 하고 판정에 쓰지 않는다. */
export const VC_SIGNALS_069500 = ["V1", "V4"] as const;
export const VC_HORIZONS = [5, 21, 63] as const;
export const VC_DS6_ROW = { signal: "V4", h: 21 } as const;
/** 학습 구간에서 본 방향(기울기 부호): 후보 7행 모두 양수. */
export const VC_LEARN_SIGN = 1;
/** 1단계 DS6 일별 수익(대상 DS6 행용) 재현 점검: 연속 전체 2011-01-04~2026-10-26이 이 기록과 CAGR 차이 이내·MDD 둘째 자리 일치(연구 DS6 후속 진단 기록, 스캔 추기 c8dd304의 완화 기준과 같은 방식). */
export const VC_DS6_FULL_REC = { cagr: 11.7, mdd: 39.15 } as const;
export const VC_DS6_CAGR_TOL = 0.01;

// ---- 2단계: DS12(시도 286). 기본은 DS6(연구 DS5·DS6/272 정의: 코어 40% = K200P 상위 2종목 시총가중·교체 5거래일 연속 순위 밖, 위성 60% = LV1, 일별 목표 비중 리밸 이동 비용 0.25%) ----
export const DS12_PRIOR_TESTS = 285;
export const DS12_TRIAL = 286;
/** 바뀌는 것은 LV1의 목표 배율 m뿐: 판단일 c의 전일(CAL[c−1]) VKOSPI 종가가 THR 이상이면 m = 1(변동성 때문에 줄이지 않음). 그 외 날과 VKOSPI 값이 없는 날(2011-01-03 이전)은 DS6와 같은 m(20일 변동성 기준 min(1, 20%÷σ)). */
export const DS12_THR = 25;
/** 게이트 D 이웃(하나씩만 바꿈): 임계값 22·28, THR에서 PERSIST거래일 연속 유지(CAL[c−PERSIST..c−1]이 모두 THR 이상)해야 적용, 코어 비중 ±10%p(30%·50%, 위성 70%·50%). */
export const DS12_NB_THR = [22, 28] as const;
export const DS12_PERSIST_DAYS = 5;
/** 게이트 F 참고선 분모: 1 − 0.05 ÷ (이번 사전등록의 후보 수 = 1). */
export const DS12_F_DENOMINATOR = 1;
/** VKOSPI 정리본(Actions 캐시 research-vkospi-inputs-20261105) 전 연도 파일을 쓴다. */
