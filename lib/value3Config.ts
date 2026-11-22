// 저PBR 대형주 시험 VL1(316)·VL1C(317) 기준값. 사용자 지정 2026-11-22. 사전등록: docs/research/value3-prereg.md (첫 시험 전 커밋).
// 값은 첫 시험 전에 고정했고 결과를 보고 바꾸지 않는다(구현의 논리 결함만 사유를 기록하고 고친다).
import type { VbP } from "@/lib/valueConfig";
import { VB1_P0 } from "@/lib/valueConfig";
export const V3_FIRST_TRIAL = 316;
export const V3_PRIOR_TESTS = 315;
/** 게이트 F 참고선: 1 − 0.05 ÷ (이번 사전등록의 후보 수 2). 판정 기준 자체(백분위 ≥ 95)는 바뀌지 않는다. */
export const V3_F_DENOMINATOR = 2;
/** 유니버스: k200p = 신호일 K200P(PIT, 코스피 시총 상위 200) ∩ BS1 적격, top300 = BS1 적격 종목 중 신호일 시총 상위 300(코스피·코스닥 합). */
export type VlUniv = "k200p" | "top300";
export interface VlP extends VbP { univ: VlUniv }
export const VL1_P0: VlP = { ...VB1_P0, univ: "k200p" };
/** 시총 상위 N(이웃값 유니버스). */
export const V3_TOP_N = 300;
export const VL1_NB: [string, Partial<VlP>][] = [["종목 수 20", { n: 20 }], ["종목 수 40", { n: 40 }], ["PBR 보고서 최대 경과일 300", { maxAge: 300 }], ["PBR 보고서 최대 경과일 500", { maxAge: 500 }], [`유니버스 시총 상위 ${V3_TOP_N} (K200P 대신)`, { univ: "top300" }]];
/** 정보용: VB1 최대 낙폭 구간(앞선 점검 2018-01-29 → 2020-03-23)을 시가총액 3분위로 분해. */
export const V3_MDD_WINDOW = { from: "2018-01-29", to: "2020-03-23" } as const;
export const V3_TERCILES = 3;
/** 정보용 보고 대상: 삼성전자·SK하이닉스. */
export const V3_WATCH = ["005930", "000660"] as const;
