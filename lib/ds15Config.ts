// DS15L(339)·DS15M(340) 기준값. 사용자 지정 2026-11-27. 사전등록: docs/research/ds15-prereg.md (첫 시험 전 커밋).
// 값은 첫 시험 전에 고정했고 결과를 보고 바꾸지 않는다(구현의 논리 결함만 사유를 기록하고 고친다).
import type { Alloc3 } from "@/lib/ds13Config";
export const DS15_FIRST_TRIAL = 339;
export const DS15_PRIOR_TESTS = 338;
/** 게이트 F 참고선: 1 − 0.05 ÷ (이번 사전등록의 후보 수 2). 판정 기준 자체(백분위 ≥ 95)는 바뀌지 않는다. */
export const DS15_F_DENOMINATOR = 2;
/**
 * 하위 계좌 비중은 DS13(`DS13_W` = 40/30/30: 코어(DS6 코어) / 모멘텀 위성 / 저위험 위성)과 같고 월 1회 재조정(`combineN`, 이동 비용 `CS_MOVE_COST`)도 같다.
 * 모멘텀 위성만 RM1에서 RM1S(RM1 신호 + 진입 후 최고 종가 대비 −20% 손절, `RM1S_P0`)로 바뀐다. 저위험 위성은 DS15L = LV1(DS13L과 같음), DS15M = MV1(DS13M과 같음).
 */
/** 게이트 D 이웃값(사용자 지정): 코어 35%·45%(위성은 비율 유지 → 35/32.5/32.5, 45/27.5/27.5). 손절 −15%·−25%는 `RM1S_NB`(lib/stopConfig.ts)를 그대로 쓴다. */
export const DS15_NB_W: [string, Alloc3][] = [["코어 비중 35% (위성 비례)", [0.35, 0.325, 0.325]], ["코어 비중 45% (위성 비례)", [0.45, 0.275, 0.275]]];
/**
 * 사전 점검 재현 기록(RM1 시작과 같은 2011-02-01, 연속 CAGR / MDD %). 출처: ds13-summary.md(보정만 적용 = correct), stop-summary.md·hm1/rm1v 요약표(보정 + 0% 처리 = std), rm1v-summary.md 정보용(보정만 적용 RM1SC).
 * DS13M은 보정 + 0% 처리 표준의 기록이 없어 그 표준에서는 값만 보고하고 대조하지 않는다.
 */
export const DS15_REF = {
  std: { rm1sc: [13.48, 34.87], ds13l: [12.47, 37.91] },
  correct: { rm1sc: [13.38, 34.87], ds13l: [12.4, 37.91], ds13m: [11.57, 40.29] },
} as const;
