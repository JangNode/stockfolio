// 연구 DS7(시도 273) 기준값. 사용자 지정 2026-11-04. 사전등록: docs/research/ds7-prereg.md
// DS7 = DS6 기본 계좌(코어 40% + LV1 60%, 연구 DS5·DS6 정의 그대로) + 계좌 전체 노출 배율 s(t) = min(1, 목표변동성 ÷ σ(t)). 값은 시험 전에 고정했고 결과를 본 뒤 바꾸지 않는다.
// 코어 정의 상수(CS_SWAP_CONFIRM_DAYS, CS_RANK_DEPTH)·합성 이동 비용(CS_MOVE_COST)·코어 비중 이웃 폭(CS_CORE_W_NEIGHBOR)은 연구 CS의 상수를 그대로 쓴다.
export const DS7_PRIOR_TESTS = 272;
export const DS7_TRIAL = 273;
/** 초기 배분 종가 날짜(LV1 250거래일 워밍업 뒤 첫 거래일). 수익 집계는 다음 거래일(2011-01-04)부터 데이터 끝까지 이어서 계산한다. */
export const DS7_RUN_START = "2011-01-03";
/** 목표변동성(연, 소수). 사용자 지정 15%. */
export const DS7_TARGET_VOL = 0.15;
/** σ(t) 계산에 쓰는 직전 거래일 수. 이 일수 동안(처음 60거래일)은 배율 1. */
export const DS7_VOL_WINDOW = 60;
/** σ 연환산 일수(√252). */
export const DS7_ANN_DAYS = 252;
// 배율 변경 이동액 비용은 DS6 코어-위성 합성 이동 비용과 같은 0.25%(CS_MOVE_COST)를 그대로 쓴다.
/** 게이트 D 이웃: 목표변동성, σ 창, (코어 비중은 CS_CORE_W_NEIGHBOR ±10%p = 30%·50%). */
export const DS7_NB_TARGET_VOLS = [0.12, 0.18] as const;
export const DS7_NB_WINDOWS = [40, 90] as const;
/** 후보 기본값: DS6과 같은 코어 40%, 코어 2종목, 위성 LV1 단독. */
export const DS7_CAND = { id: "DS7", trial: DS7_TRIAL, coreW: 0.4, coreN: 2, sat: ["LV1"] } as const;
/** 평가 구간 3개(이름, 시작, 끝). 연속 전체 2011-01-04~2026-10-26 안의 하위 구간이다(2017-01~03은 연속 전체에만 들어간다). */
export const DS7_WINDOWS: readonly (readonly [string, string, string])[] = [
  ["구간 1 2011-01~2016-12", "2011-01-01", "2016-12-30"],
  ["구간 2 2017-04~2021-12", "2017-04-04", "2021-12-31"],
  ["구간 3 2022-01~2026-10", "2022-01-01", "9999-12-31"],
];
/** DS6 기록(연구 DS6 후속 진단, 연속 2011-01-04~2026-10-26): 일관성 확인용(정지 조건)과 비교 표용. */
export const DS7_DS6_REF = { 전체: [11.7, 39.15], 구간1: [4.1, 24.51] } as const;
/** 진단 "코어에서 시총 1위를 뺀 경우": 매 거래일 코어 순위 목록 맨 앞 1종목 제외. */
export const DS7_DROP_TOP = 1;
