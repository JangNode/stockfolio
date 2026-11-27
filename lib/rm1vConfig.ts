// 잔차 모멘텀 + 역변동성 비중 시험 RM1V(337)·RM1VC(338) 기준값. 사용자 지정 2026-11-27. 사전등록: docs/research/rm1v-prereg.md (첫 시험 전 커밋).
// 값은 첫 시험 전에 고정했고 결과를 보고 바꾸지 않는다(구현의 논리 결함만 사유를 기록하고 고친다).
import { B5_RM_P0, type RmP } from "@/lib/batch5Config";
export const RV_FIRST_TRIAL = 337;
export const RV_PRIOR_TESTS = 336;
/** 게이트 F 참고선: 1 − 0.05 ÷ (이번 사전등록의 후보 수 2). 판정 기준 자체(백분위 ≥ 95)는 바뀌지 않는다. */
export const RV_F_DENOMINATOR = 2;
/**
 * 신호·유니버스·보유 종목 수(n = 20)·유지 순위(n × keepMult = 40)·월 리밸·체결은 RM1(B5_RM_P0)과 완전히 같다. 비중만 바꾼다:
 * volWin: 변동성 창(직전 volWin거래일 일간 수익률의 표준편차), cap: 종목당 비중 상한(넘는 몫은 나머지 종목에 역변동성 비율로 재배분, 상한 반복 적용).
 * cap = 1/n이면 모든 비중이 1/n이 되어 RM1과 같다(사전 점검 불변식).
 */
export interface RvP extends RmP { volWin: number; cap: number }
export const RV1_P0: RvP = { ...B5_RM_P0, volWin: 60, cap: 0.1 };
/** 게이트 D 이웃값(사용자 지정, 한 번에 하나만 변경): 변동성 창 40·90거래일, 종목당 상한 8%·15%. */
export const RV1_NB: [string, Partial<RvP>][] = [["변동성 창 40일", { volWin: 40 }], ["변동성 창 90일", { volWin: 90 }], ["종목당 상한 8%", { cap: 0.08 }], ["종목당 상한 15%", { cap: 0.15 }]];
/** 변동성 계산에 필요한 최소 가격 행 비율(창 안 실제 종가 행이 이 비율 × volWin개 이상). 미달·표준편차 0이면 그 종목은 "변동성 불가"로 보고 선정된 종목들의 변동성 중앙값을 쓴다(선정 자체는 바꾸지 않는다). */
export const RV_MIN_VALID_FRAC = 0.8;
/** 사전 점검 RM1 재현 기록(RM1 자신의 시작 2011-01-31, 연속 CAGR / MDD %): 시험 표준 = 보정 + 0% 처리, none = 보정·처리 없는 원 시험. 출처: batch5-summary.md(294·295), stop-summary.md, composite-summary.md(cmpre 점검 3). */
export const RV_REF = { std: { rm1: [7.82, 68.57], rm1c: [12.59, 45.17] }, none: { rm1: [6.85, 67.97], rm1c: [11.98, 44.88] } } as const;
