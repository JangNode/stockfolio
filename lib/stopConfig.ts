// 잔차 모멘텀 + 손절 시험 RM1S(329)·RM1SC(330) 기준값. 사용자 지정 2026-11-26. 사전등록: docs/research/stop-prereg.md (첫 시험 전 커밋).
// 값은 첫 시험 전에 고정했고 결과를 보고 바꾸지 않는다(구현의 논리 결함만 사유를 기록하고 고친다).
import type { RmP } from "@/lib/batch5Config";
import { B5_RM_P0 } from "@/lib/batch5Config";
export const S_FIRST_TRIAL = 329;
export const S_PRIOR_TESTS = 328;
/** 게이트 F 참고선: 1 − 0.05 ÷ (이번 사전등록의 후보 수 2). 판정 기준 자체(백분위 ≥ 95)는 바뀌지 않는다. */
export const S_F_DENOMINATOR = 2;
/** stop: 진입 후 최고 종가 대비 하락률(0.2 = −20%). 이 값 이하로 내려간 종가가 나오면 다음 거래일 종가에 전량 매도(비중은 현금), 다음 월말 리밸런스 전까지 재진입·재배분 없음. 나머지 정의는 RM1(B5_RM_P0)과 완전히 같다. */
export interface RmsP extends RmP { stop: number }
export const RM1S_P0: RmsP = { ...B5_RM_P0, stop: 0.2 };
/** 게이트 D 이웃값(사용자 지정): 손절 −15%, −25%. */
export const RM1S_NB: [string, Partial<RmsP>][] = [["손절 -15%", { stop: 0.15 }], ["손절 -25%", { stop: 0.25 }]];
/** 정보용: 손절 발동 뒤 "다음 달 수익"을 재는 거래일 수(체결일 종가 → 이후 21거래일 종가, 수정 종가). */
export const S_NEXT_MONTH_DAYS = 21;
/** 사전 점검 RM1 재현 기록: 데이터 표준별 RM1C(RM1 + DS6 코어 40% 일별 재조정) 연속 CAGR / MDD(%) 와 보정 없는 원 시험(294·295)의 RM1·RM1C. 출처: batch5-summary.md, k200p-correction-summary.md, 앞선 시험 [R5] 표. */
export const S_REF = {
  none: { rm1: [6.85, 67.97], rm1c: [11.98, 44.88] },
  correct: { rm1c: [12.44, 45.17] },
  correctZero: { rm1c: [12.59, 45.17] },
} as const;
