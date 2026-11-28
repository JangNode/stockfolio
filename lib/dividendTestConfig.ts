// 배당 시험 DV1(341)·DV1C(342) 기준값. 사용자 지정 2026-11-28. 사전등록: docs/research/div-prereg.md (첫 시험 전 커밋).
// 값은 첫 시험 전에 고정했고 결과를 보고 바꾸지 않는다(구현의 논리 결함만 사유를 기록하고 고친다).
export const DV_FIRST_TRIAL = 341;
export const DV_PRIOR_TESTS = 340;
/** 게이트 F 참고선: 1 − 0.05 ÷ (이번 사전등록의 후보 수 2). 판정 기준 자체(백분위 ≥ 95)는 바뀌지 않는다. */
export const DV_F_DENOMINATOR = 2;
/**
 * n: 보유 종목 수(동일 비중 1/n), keepMult: 기존 보유는 순위 n × keepMult 이내면 유지(기본 30 × 2 = 60).
 * 순위 점수: 배당수익률 = (가장 최근 사업연도 보통주 주당 현금배당금) ÷ 월말 원종가, 내림차순. 후보 = BS1 적격 ∧ 배당 연속성 만족 종목.
 */
export interface DvP { n: number; keepMult: number; maxAge: number }
/** maxAge: 배당 보고서 접수일부터 월말까지 허용하는 최대 경과일(초과하면 그 월말에는 제외). 연속성 조건의 직전 사업연도 수 3은 정의의 일부(DV_HIST_YEARS)라 옵션이 아니다. */
export const DV_HIST_YEARS = 3;
export const DV1_P0: DvP = { n: 30, keepMult: 2, maxAge: 400 };
/** 게이트 D 이웃값(사용자 지정): 종목 수 20·40(유지 배수 2 유지 → 유지 순위 40·80), 유지 순위 45·90(종목 수 30 → 유지 배수 1.5·3). */
export const DV_NB: [string, Partial<DvP>][] = [["종목 수 20", { n: 20 }], ["종목 수 40", { n: 40 }], ["유지 순위 45", { keepMult: 1.5 }], ["유지 순위 90", { keepMult: 3 }]];
/** 시작일 규칙(사용자 지정): BS1 적격 월말 종목 중 배당수익률이 계산되는 비율이 이 값 이상이 처음 되는 월말. 못 넘으면 멈추고 보고. */
export const DV_COVERAGE_MIN = 0.6;
/** DV1C = 코어(DS6 코어) 40% + DV1 60%, 월 1회 재조정(HM1C와 같은 방식). 가중치는 [코어, DV1]. */
export const DV1C_W: [number, number] = [0.4, 0.6];
/** 구간(사용자 지정): 시작일~2021-12-31 / 2022-01-01~데이터 종료. 게이트 B는 두 구간 모두 069500을 이길 때만 통과. */
export const DV_WIN1_TO = "2021-12-31";
export const DV_WIN2_FROM = "2022-01-01";
/** 사전 점검 재현 기록(DS6, 시작 2011-02-01, 보정 + 0% 처리 표준, 연속 CAGR / MDD %). 출처: ds13-summary.md. */
export const DV_DS6_REF: [number, number] = [11.7, 39.15];
/** 독립 재계산 대조 건수(사용자 지정 400). */
export const DV_RECALC_N = 400;
/** 시작일: 시작일 규칙(DV_COVERAGE_MIN)을 데이터 점검(dvcov)으로 적용한 결과. 사전등록(div-prereg.md) 확정 전에는 빈 문자열. */
export const DV_START = "";
