// 연구 DS6 2017 이전 구간 독립 확인(시도 272) 기준값. 사용자 지정 2026-11-03. 사전등록: docs/research/ds6-pre2017-prereg.md
// 후보 정의(DS6)는 연구 DS5·DS6(docs/research/ds5-prereg.md)와 같고 바꾸지 않는다. 코어 정의 상수(CS_SWAP_CONFIRM_DAYS, CS_RANK_DEPTH)·합성 이동 비용(CS_MOVE_COST)·
// 코어 비중 이웃 폭(CS_CORE_W_NEIGHBOR)·변동성 창(IVA_VOL_WINDOW)은 연구 CS·IVA의 상수를 그대로 쓴다.
export const P17_PRIOR_TESTS = 271;
export const P17_TRIAL = 272;
/** 초기 배분 종가 날짜(= LV1 평가 시작 판단일; 가격 Parquet이 2010-01-04부터라 250거래일 워밍업 뒤 첫 거래일). 수익 집계는 다음 거래일(2011-01-04)부터. */
export const P17_RUN_START = "2011-01-03";
/** 평가 끝(사용자 지정). 이 날짜까지 달력을 잘라 모든 시뮬레이션이 이 날짜에서 끝난다(미래 데이터 없음). */
export const P17_END = "2016-12-30";
/** 구간 3분할(2년씩, 결과를 보기 전에 고정). [이름, 시작, 끝] */
export const P17_WINDOWS: readonly (readonly [string, string, string])[] = [
  ["구간 1 2011~2012", "2011-01-01", "2012-12-31"],
  ["구간 2 2013~2014", "2013-01-01", "2014-12-31"],
  ["구간 3 2015~2016", "2015-01-01", "2016-12-30"],
];
/** 후보: DS6 그대로 — 코어 40%(시총 상위 2종목), 위성 60% = LV1 단독. 게이트 D 이웃은 코어 비중 ±10%p와 코어 1·3종목(위성 변동성 창 이웃은 구성요소 하나라 퇴화 이웃이므로 사용자 지정대로 쓰지 않는다). */
export const P17_CAND = { id: "DS6", trial: P17_TRIAL, coreW: 0.4, coreN: 2, sat: ["LV1"], nNeighbors: [1, 3] } as const;
/** 진단 "코어에서 시총 1위 종목을 뺀 경우": 매 거래일 코어 순위 목록의 맨 앞(시총 1위) 1종목을 빼고 나머지에서 상위 코어 종목 수만큼 고른다. */
export const P17_DROP_TOP = 1;
/** 2017 이후 구간(연구 DS5·DS6)에서 이미 본 DS6 기록(참고, 이번 구간과 겹치지 않음). 출처: docs/research/ds5-prereg.md. */
export const P17_DS6_LATER = { 학습: [3.65, 29.56], 확인: [16.94, 25.22], 보류: [22.54, 33.66], 전체: [15.65, 39.15] } as const;
