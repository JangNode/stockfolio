// 저PBR + 잔차 모멘텀 복합 시험 CM1(333)·CM1S(334) 기준값. 사용자 지정 2026-11-27. 사전등록: docs/research/composite-prereg.md (첫 시험 전 커밋).
// 값은 첫 시험 전에 고정했고 결과를 보고 바꾸지 않는다(구현의 논리 결함만 사유를 기록하고 고친다).
import { B5_RM_P0 } from "@/lib/batch5Config";
import { VB1_P0 } from "@/lib/valueConfig";
export const CM_FIRST_TRIAL = 333;
export const CM_PRIOR_TESTS = 332;
/** 게이트 F 참고선: 1 − 0.05 ÷ (이번 사전등록의 후보 수 2). 판정 기준 자체(백분위 ≥ 95)는 바뀌지 않는다. */
export const CM_F_DENOMINATOR = 2;
/**
 * n: 보유 종목 수(동일 비중 1/n), keepMult: 기존 보유는 평균 순위 n × keepMult 이내면 유지(기본 30 × 2 = 60),
 * stop: 진입 후 최고 종가 대비 하락률(CM1S만 쓴다; CM1은 값을 보지 않는다. 0.2 = −20%).
 * 순위 점수 = (PBR 순위 + 잔차 모멘텀 순위) ÷ 2, 두 순위 모두 1 = 가장 좋음(PBR 낮을수록, RM1 점수 높을수록), 같은 후보 집합(아래 조건을 모두 채운 종목) 안에서 매긴다.
 * PBR 조건·유니버스(BS1 적격, 접수일 < 신호일, 보고서 경과 maxAge 이내, 자본 > 0)는 VB1(VB1_P0), 잔차 모멘텀 점수·조건(창 t−252~t−21, 유효 200일 이상, 069500 회귀)은 RM1(B5_RM_P0)과 같다.
 */
export interface CmP { n: number; keepMult: number; stop: number; maxAge: number; rm: typeof B5_RM_P0 }
export const CM1_P0: CmP = { n: 30, keepMult: 2, stop: 0.2, maxAge: VB1_P0.maxAge, rm: B5_RM_P0 };
export const CM1S_P0: CmP = { ...CM1_P0, stop: 0.2 };
/** 게이트 D 이웃값(사용자 지정): 종목 수 20·40(유지 배수 2 유지 → 유지 순위 40·80), 유지 순위 45·90(종목 수 30 → 유지 배수 1.5·3). */
export const CM1_NB: [string, Partial<CmP>][] = [["종목 수 20", { n: 20 }], ["종목 수 40", { n: 40 }], ["유지 순위 45", { keepMult: 1.5 }], ["유지 순위 90", { keepMult: 3 }]];
/** 게이트 D 이웃값(사용자 지정): 손절 −15%, −25%. */
export const CM1S_NB: [string, Partial<CmP>][] = [["손절 -15%", { stop: 0.15 }], ["손절 -25%", { stop: 0.25 }]];
/** 시작: VB1과 같은 첫 신호일 2011-05-31(수익 집계 2011-06-01~). */
export const CM_START = "2011-05-31";
/** 사전 점검 VB1 재현 기록(연속 CAGR / MDD, 시험 표준·시작 2011-05-31): 출처 value-summary.md, vbstop-summary.md [R5]. */
export const CM_REF = { vb1: [10.07, 64.17] } as const;
