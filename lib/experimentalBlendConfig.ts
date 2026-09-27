import type { PaperStyle } from "@/lib/paperStyles";

/** "실험조합형" AI 모의투자 스타일의 style 값. scripts/paper-trade.ts와
 * components/PaperTrading.tsx가 이 상수로 "이 스타일이 실험조합형인가"를 판단해,
 * 하드코딩된 문자열 리터럴이 여기저기 흩어지지 않게 한다. */
export const EXPERIMENTAL_BLEND_STYLE: PaperStyle = "experimental_blend";

// "실험조합형" AI 모의투자 스타일의 rule_type별 목표비중(2026-09-27 조정, 최초
// 확정은 2026-09-24). 매수 시점 게이팅에만 쓰고 강제 리밸런싱(초과분 매도)은
// 하지 않는다.
//
// 이전 값(2026-09-24~09-27): minervini 54% / peg_lynch 36% / reversal_breakout 10%
// (diagnose-portfolio-allocation-simulation.ts 기준 CAGR 17.3%/MDD 29.6%로 당시
// 가장 우수했던 조합).
//
// 조정 근거(2026-09-27): 장기 백테스트(strategy_backtest_summary) 재검증에서
// reversal_breakout이 상위 3개 종목만 제외해도 CAGR이 26.9%→3.1%(89% 증발)로
// 무너지는 것으로 확인됨(5개 제외 시 부호까지 반전) — 기존에 알려졌던 것보다
// 소수 종목 의존도가 더 큰 구조. diagnose-portfolio-allocation-simulation.ts를
// 10%/5% 비중으로 재실행한 결과, reversal_breakout 비중을 10%→5%로 낮춰도
// MDD 방어 효과는 거의 그대로 유지되고(29.6%→29.7%, 사실상 동일 — 분산 효과가
// 이미 5%에서 대부분 실현됨) CAGR만 17.3%→15.2%로 낮아짐 — 그 차이분은 소수
// 잭팟 트레이드 의존분일 가능성이 커, 완전히 배제하지 않고 5%로 최소화했다
// (그 잭팟 메커니즘 자체는 매년 흩어져 반복 관측돼 순수 우연은 아니라는 근거가
// 있었기 때문). 화면에 노출되는 설명 문구는
// supabase/migrations/20260927230000_update_experimental_blend_weights_label.sql이
// 함께 갱신한다.
export const EXPERIMENTAL_BLEND_TARGET_WEIGHTS: Record<
  "minervini_trend_template" | "peg_lynch" | "reversal_breakout",
  number
> = {
  minervini_trend_template: 0.57,
  peg_lynch: 0.38,
  reversal_breakout: 0.05,
};
