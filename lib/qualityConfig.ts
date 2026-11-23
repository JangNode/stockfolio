// 재무 품질(ROE) 시험 Q1(320)·QV1(321)·QV1C(322) 기준값. 사용자 지정 2026-11-23. 사전등록: docs/research/quality-prereg.md (첫 시험 전 커밋).
// 값은 첫 시험 전에 고정했고 결과를 보고 바꾸지 않는다(구현의 논리 결함만 사유를 기록하고 고친다).
import type { VbP } from "@/lib/valueConfig";
export const Q_FIRST_TRIAL = 320;
export const Q_PRIOR_TESTS = 319;
/** 게이트 F 참고선: 1 − 0.05 ÷ (이번 사전등록의 후보 수 3). 판정 기준 자체(백분위 ≥ 95)는 바뀌지 않는다. */
export const Q_F_DENOMINATOR = 3;
/** wP: PBR 하위 백분위 가중, wR: ROE 상위 백분위 가중. Q1 = ROE만(wP = 0), QV1 = 1 : 1. maxAge는 PBR용 자본 보고서·ROE용 보고서 모두에 적용한다. */
export interface QP extends Omit<VbP, "wB"> { wR: number }
export const Q1_P0: QP = { n: 30, keepMult: 3, maxAge: 400, wP: 0, wR: 1 };
export const QV1_P0: QP = { n: 30, keepMult: 3, maxAge: 400, wP: 1, wR: 1 };
export const Q1_NB: [string, Partial<QP>][] = [["종목 수 20", { n: 20 }], ["종목 수 40", { n: 40 }], ["보고서 최대 경과일 300", { maxAge: 300 }], ["보고서 최대 경과일 500", { maxAge: 500 }]];
export const QV1_NB: [string, Partial<QP>][] = [...Q1_NB, ["가중 2:1 (PBR : ROE)", { wP: 2, wR: 1 }], ["가중 1:2 (PBR : ROE)", { wP: 1, wR: 2 }]];
/** 시험 시작일(첫 신호일). 정기 재무 TTM 계산 가능 종목이 BS1 적격 종목 수의 60% 이상이 되고 이후 계속 유지되는 첫 월말 — 데이터 보강 뒤 확정(quality-prereg.md §1). */
export const Q_COVERAGE_MIN = 0.6;
/** 사전 승인된 완화: 2011-06 월말에서 60% 미만이면 60% 이상이 처음 되고 계속 유지되는 월말로 시작하고, 구간 2개(2016-05 이전 시작이어도 C-2 구간 규칙), 게이트 B는 두 구간 모두 069500 우위. */
export const Q_PLANNED_START = "2011-06-30";
/** 정보용: 금융 업종 = KSIC 2자리 64(금융업)·65(보험·연금)·66(금융·보험 관련 서비스). */
export const Q_FIN_KSIC = ["64", "65", "66"] as const;
