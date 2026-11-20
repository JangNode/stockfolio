// 저평가(PBR) 시험 VB1(311)·VB2(312)·VB1C(313) 기준값. 사용자 지정 2026-11-20. 사전등록: docs/research/value-prereg.md (첫 시험 전 커밋).
// 값은 첫 시험 전에 고정했고 결과를 보고 바꾸지 않는다(구현의 논리 결함만 사유를 기록하고 고친다).
export const VB_FIRST_TRIAL = 311;
export const VB_PRIOR_TESTS = 310;
/** 게이트 F 참고선: 1 − 0.05 ÷ (이번 사전등록의 후보 수 3). 판정 기준 자체(백분위 ≥ 95)는 바뀌지 않는다. */
export const VB_F_DENOMINATOR = 3;
export interface VbP {
  /** 보유 종목 수(동일 비중 1/n). */
  n: number;
  /** 기존 보유는 순위가 n × keepMult 안이면 유지(BS1과 같은 3배). */
  keepMult: number;
  /** PBR용 자본 보고서의 접수일부터 신호일까지 허용하는 최대 경과일. 넘으면 그 종목은 그 달 제외. */
  maxAge: number;
  /** 점수 가중: BS1 점수(변동성·급등·회전율 백분위 평균) 대 PBR 백분위. wB = 0이면 PBR 순위만(VB1). */
  wB: number;
  wP: number;
}
export const VB1_P0: VbP = { n: 30, keepMult: 3, maxAge: 400, wB: 0, wP: 1 };
export const VB2_P0: VbP = { n: 30, keepMult: 3, maxAge: 400, wB: 1, wP: 1 };
export const VB1_NB: [string, Partial<VbP>][] = [["종목 수 20", { n: 20 }], ["종목 수 40", { n: 40 }], ["PBR 보고서 최대 경과일 300", { maxAge: 300 }], ["PBR 보고서 최대 경과일 500", { maxAge: 500 }]];
export const VB2_NB: [string, Partial<VbP>][] = [...VB1_NB, ["가중 2:1 (BS1 : PBR)", { wB: 2, wP: 1 }], ["가중 1:2 (BS1 : PBR)", { wB: 1, wP: 2 }]];
/** 자본 커버리지 70% 이상이 되는 첫 월말(그 뒤 모든 월말도 70% 이상)을 시험 시작일로 확정(C-1). BS1 적격 종목 기준 종목 수 비율. */
export const VB_COVERAGE_MIN = 0.7;
/** C-2(파일럿 미달·수집 실패): 시험 시작일(첫 신호일) 2016-05-31 이후, 구간 2016-05~2021-12 / 2022-01~2026-10-26, 게이트 B는 두 구간 모두 069500 우위. */
export const VB_C2_START = "2016-05-31";
export const VB_C2_WINDOW1_TO = "2021-12-31";
export const VB_C2_WINDOW2_FROM = "2022-01-01";
export const VB_EQ_AGE_NB = [300, 500] as const;
