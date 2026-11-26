// 저PBR + 손절 시험 VB1S(331)·VB1SC(332) 기준값. 사용자 지정 2026-11-26. 사전등록: docs/research/vbstop-prereg.md (첫 시험 전 커밋).
// 값은 첫 시험 전에 고정했고 결과를 보고 바꾸지 않는다(구현의 논리 결함만 사유를 기록하고 고친다).
import type { VbP } from "@/lib/valueConfig";
import { VB1_P0 } from "@/lib/valueConfig";
export const VS_FIRST_TRIAL = 331;
export const VS_PRIOR_TESTS = 330;
/** 게이트 F 참고선: 1 − 0.05 ÷ (이번 사전등록의 후보 수 2). 판정 기준 자체(백분위 ≥ 95)는 바뀌지 않는다. */
export const VS_F_DENOMINATOR = 2;
/** stop: 진입 후 최고 종가 대비 하락률(0.2 = −20%). 이 값 이하로 내려간 종가가 나오면 다음 거래일 종가에 전량 매도(비중은 현금), 다음 월말 리밸런스 전까지 재진입·재배분 없음(RM1S와 같은 구현). 나머지 정의는 VB1(VB1_P0)과 완전히 같다. */
export interface VbsP extends VbP { stop: number }
export const VB1S_P0: VbsP = { ...VB1_P0, stop: 0.2 };
/** 게이트 D 이웃값(사용자 지정): 손절 −15%, −25%. */
export const VB1S_NB: [string, Partial<VbsP>][] = [["손절 -15%", { stop: 0.15 }], ["손절 -25%", { stop: 0.25 }]];
/** 시험 시작 월말 신호일 = 기존 VB1과 같다(첫 체결 2011-06-01, 수익 집계 2011-06-01~). 사용자 지시문의 "2011-06-30"은 이 시작(2011-06~)을 가리키는 것으로 해석했다(vbstop-prereg.md §2). */
export const VS_START = "2011-05-31";
/** 사전 점검 재현 기록(앞선 저PBR 시험 311·313, 보정 + 의심 종목-일 0% 처리, 시작 2011-05-31): 연속 CAGR / MDD(%). */
export const VS_REF = { vb1: [10.07, 64.17], vb1c: [14.23, 48.78] } as const;
