// 이익수익률 시험 EY1(327)·EY1C(328) 기준값. 사용자 지정 2026-11-26. 사전등록: docs/research/ey-prereg.md (첫 시험 전 커밋).
// 값은 첫 시험 전에 고정했고 결과를 보고 바꾸지 않는다(구현의 논리 결함만 사유를 기록하고 고친다).
export const E_FIRST_TRIAL = 327;
export const E_PRIOR_TESTS = 326;
/** 게이트 F 참고선: 1 − 0.05 ÷ (이번 사전등록의 후보 수 2). 판정 기준 자체(백분위 ≥ 95)는 바뀌지 않는다. */
export const E_F_DENOMINATOR = 2;
/** n: 보유 종목 수(동일 비중 1/n), keepMult: 기존 보유 유지 순위 = n × keepMult, maxAge: ROE·순이익 TTM에 쓰는 보고서 접수 후 최대 경과일(ROE 시험과 같은 400). */
export interface EyP { n: number; keepMult: number; maxAge: number }
export const EY1_P0: EyP = { n: 30, keepMult: 2, maxAge: 400 };
/** 게이트 D 이웃값(사용자 지정): 종목 수 20·40(유지 순위는 항상 2배), 유지 순위 45·90(종목 수 30 고정, keepMult 1.5·3). */
export const EY1_NB: [string, Partial<EyP>][] = [["종목 수 20", { n: 20 }], ["종목 수 40", { n: 40 }], ["유지 순위 45", { keepMult: 1.5 }], ["유지 순위 90", { keepMult: 3 }]];
/** 시험 시작일(첫 신호일): ROE 시험과 같다(정기 재무 TTM 계산 가능 종목이 BS1 적격 종목 수의 60% 이상으로 유지되는 첫 월말). */
export const E_PLANNED_START = "2012-04-30";
