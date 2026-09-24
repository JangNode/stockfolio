import type { PaperStyle } from "@/lib/paperStyles";

/** "실험조합형" AI 모의투자 스타일의 style 값. scripts/paper-trade.ts와
 * components/PaperTrading.tsx가 이 상수로 "이 스타일이 실험조합형인가"를 판단해,
 * 하드코딩된 문자열 리터럴이 여기저기 흩어지지 않게 한다. */
export const EXPERIMENTAL_BLEND_STYLE: PaperStyle = "experimental_blend";

// "실험조합형" AI 모의투자 스타일의 rule_type별 목표비중(2026-09-24 확정).
// 2016~2026년 백테스트(diagnose-portfolio-allocation-simulation.ts 실행분) 기준
// CAGR 17.3%/MDD 29.6%로 가장 우수했던 조합. 매수 시점 게이팅에만 쓰고
// 강제 리밸런싱(초과분 매도)은 하지 않는다.
export const EXPERIMENTAL_BLEND_TARGET_WEIGHTS: Record<
  "minervini_trend_template" | "peg_lynch" | "reversal_breakout",
  number
> = {
  minervini_trend_template: 0.54,
  peg_lynch: 0.36,
  reversal_breakout: 0.1,
};
