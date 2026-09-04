import { RIM_MARKET_RISK_PREMIUM_PCT } from "@/lib/rimConfig";

/** CAPM 요구수익률(%) = 무위험이자율 + 베타 × 시장위험프리미엄. RIM(잔여이익모델)의
 * 할인율로 쓴다. */
export function computeRequiredReturnPct(
  riskFreeRatePct: number,
  beta: number,
  marketRiskPremiumPct: number = RIM_MARKET_RISK_PREMIUM_PCT
): number {
  return riskFreeRatePct + beta * marketRiskPremiumPct;
}
