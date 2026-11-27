// ROE 변화 시험 EG1(335)·EGM1(336) 기준값. 사용자 지정 2026-11-27. 사전등록: docs/research/roechg-prereg.md (첫 시험 전 커밋).
// 값은 첫 시험 전에 고정했고 결과를 보고 바꾸지 않는다(구현의 논리 결함만 사유를 기록하고 고친다).
import { B5_RM_P0 } from "@/lib/batch5Config";
export const EG_FIRST_TRIAL = 335;
export const EG_PRIOR_TESTS = 334;
/** 게이트 F 참고선: 1 − 0.05 ÷ (이번 사전등록의 후보 수 2). 판정 기준 자체(백분위 ≥ 95)는 바뀌지 않는다. */
export const EG_F_DENOMINATOR = 2;
/**
 * n: 보유 종목 수(동일 비중 1/n), keepMult: 기존 보유는 순위 n × keepMult 이내면 유지(기본 30 × 2 = 60), maxAge: ROE용 보고서 최대 경과일(지금·1년 전 두 값 모두에 적용, Q1과 같은 400일).
 * 순위 점수: EG1 = ROE 변화(ROE(TTM, 신호일) − ROE(TTM, 12개월 전 월말 신호일 시점)) 내림차순. EGM1 = (ROE 변화 순위 + RM1 잔차 모멘텀 순위) ÷ 2(작을수록 좋음), 후보 집합 안 서수 순위.
 * ROE 값은 Q1과 같은 `lib/qualityRoe.ts`의 TTM 정의(순이익 TTM > 0 ∧ 자본 > 0 ∧ 접수일 < 기준일 ∧ 경과 maxAge 이내일 때만 "계산됨")를 그대로 쓴다.
 */
export interface EgP { n: number; keepMult: number; maxAge: number; rm: typeof B5_RM_P0 }
export const EG1_P0: EgP = { n: 30, keepMult: 2, maxAge: 400, rm: B5_RM_P0 };
export const EGM1_P0: EgP = { ...EG1_P0 };
/** 게이트 D 이웃값(사용자 지정, EG1·EGM1 공통): 종목 수 20·40(유지 배수 2 유지 → 유지 순위 40·80), 유지 순위 45·90(종목 수 30 → 유지 배수 1.5·3). */
export const EG_NB: [string, Partial<EgP>][] = [["종목 수 20", { n: 20 }], ["종목 수 40", { n: 40 }], ["유지 순위 45", { keepMult: 1.5 }], ["유지 순위 90", { keepMult: 3 }]];
/** "1년 전 같은 시점" = 신호일 월말보다 12개월 앞선 월말 거래일(그 시점에 접수된 보고서만 사용). */
export const EG_LAG_MONTHS = 12;
/** 시작일 규칙(사전 승인 완화): BS1 적격 월말 종목 중 ROE(지금)·ROE(1년 전)가 모두 계산되는 비율이 이 값 이상이 처음 되는 월말. 못 넘으면 멈추고 보고. */
export const EG_COVERAGE_MIN = 0.6;
/** 시작일: 위 규칙을 데이터 점검(egcov, run 45939941455)으로 적용한 결과(사전등록 §6, 시험 전 기록). */
export const EG_START = "2014-04-30";
/** 사전 점검 재현 기록(ROE 시험 quality-summary.md, 시작 2012-04-30, 연속 CAGR / MDD, 보정 + 0% 처리 데이터). */
export const EG_REF = { qStart: "2012-04-30", q1: [-1.17, 66.0], qv1: [5.68, 56.79] } as const;
