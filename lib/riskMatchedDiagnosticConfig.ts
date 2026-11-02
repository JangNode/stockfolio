// 연구 진단(위험 수준을 맞춘 069500 대비 성과 비교, 시험 아님·번호 소진 없음) 기준값. 사용자 지정 2026-11-02. 문서: docs/research/risk-matched-benchmark-diagnostic.md
// 어떤 후보도 새로 정의하지 않는다: 대상은 기존 일별 순수익(PE4·W3·LV1·L3)과 그것을 연구 ALLOC·CAPREC 규칙 그대로 합친 P1~P3·Q1~Q3다.
export interface RmdWin { from: string; to: string }
/** 공통 구간(연구 ALLOC·CAPREC와 같다): 수익 집계 2017-04-04~, 학습·확인·보류, 2026년 제외. */
export const RMD_WINDOWS_2017: [string, RmdWin][] = [
  ["평가 구간 전체", { from: "2017-04-04", to: "9999-12-31" }],
  ["학습 2017-04~2019", { from: "2017-04-04", to: "2019-12-31" }],
  ["확인 2020~2021", { from: "2020-01-01", to: "2021-12-31" }],
  ["보류 2022~", { from: "2022-01-01", to: "9999-12-31" }],
  ["2026년 제외 (~2025-12-31)", { from: "2017-04-04", to: "2025-12-31" }],
];
/** W3 원래 평가 시작(2014-01-02) 기준 구간(연구 WFR·LTR와 같다). */
export const RMD_WINDOWS_2014: [string, RmdWin][] = [
  ["평가 구간 전체", { from: "2014-01-02", to: "9999-12-31" }],
  ["학습 2014~2016", { from: "2014-01-02", to: "2016-12-31" }],
  ["확인 2017~2021", { from: "2017-01-01", to: "2021-12-31" }],
  ["보류 2022~", { from: "2022-01-01", to: "9999-12-31" }],
  ["2026년 제외 (~2025-12-31)", { from: "2014-01-02", to: "2025-12-31" }],
];
/** 재조립한 합성 계좌가 이전 보고(연구 ALLOC·CAPREC)의 평가 구간 전체 CAGR / MDD와 소수 둘째 자리까지 같아야 한다. 다르면 중단한다. */
export const RMD_COMBO_REF: Record<string, { cagr: number; mdd: number }> = {
  P1: { cagr: 9.83, mdd: 29.07 },
  P2: { cagr: 13.08, mdd: 29.84 },
  P3: { cagr: 9.38, mdd: 30.92 },
  Q1: { cagr: 12.99, mdd: 36.7 },
  Q2: { cagr: 13.35, mdd: 36.62 },
  Q3: { cagr: 8.36, mdd: 40.57 },
};
/** 069500 새 기준선(2017-04-04~ 전체) 재현 기록. */
export const RMD_BENCH_REF = { cagr: 12.2, mdd: 42.03 } as const;
/** 회귀 하위 표본: 069500 일수익률 −1% 이하 = 하락일, +1% 이상 = 상승일. 강세장 = 전일 종가가 전일까지 200거래일 단순이동평균 위. */
export const RMD_DOWN_DAY = -0.01;
export const RMD_UP_DAY = 0.01;
export const RMD_REGIME_SMA = 200;
/** 위험 일치 배율 k 탐색(MDD 일치): 이분법 반복 횟수. */
export const RMD_K_ITER = 60;
