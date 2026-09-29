import type { Market } from "@/lib/market";
import { FEE_PCT_PER_SIDE, SLIPPAGE_PCT_PER_SIDE, SECURITIES_TAX_RATE_SCHEDULE } from "@/lib/transactionCostConfig";

/** dateStr(YYYY-MM-DD) 시점에 유효한 증권거래세율. market이 "KR"이 아니면(미국 등)
 * 0을 반환한다 — 한국 증권거래세는 국내 상장 종목 매도에만 적용된다. */
export function getSecuritiesTaxRate(dateStr: string, market: Market): number {
  if (market !== "KR") return 0;
  let rate = SECURITIES_TAX_RATE_SCHEDULE[0].ratePct;
  for (const step of SECURITIES_TAX_RATE_SCHEDULE) {
    if (step.effectiveFrom <= dateStr) rate = step.ratePct;
    else break;
  }
  return rate;
}

/** 매수 시 "실제 체결됐을 가격"(슬리피지+수수료로 불리하게 보정, 종가보다 비쌈). */
export function computeEffectiveBuyPrice(closePrice: number): number {
  return closePrice * (1 + SLIPPAGE_PCT_PER_SIDE) * (1 + FEE_PCT_PER_SIDE);
}

/** 매도 시 "실제 체결됐을 가격"(슬리피지+수수료+증권거래세로 불리하게 보정, 종가보다 쌈). */
export function computeEffectiveSellPrice(closePrice: number, sellDate: string, market: Market): number {
  const taxRate = getSecuritiesTaxRate(sellDate, market);
  return closePrice * (1 - SLIPPAGE_PCT_PER_SIDE) * (1 - FEE_PCT_PER_SIDE - taxRate);
}

/** 거래 하나의 비용 반영 후 수익률(비율, 0.01=1%) — buyPrice/sellPrice는 원래 종가. */
export function computeCostAdjustedReturnPct(
  buyPrice: number,
  sellPrice: number,
  sellDate: string,
  market: Market
): number {
  const effectiveBuy = computeEffectiveBuyPrice(buyPrice);
  const effectiveSell = computeEffectiveSellPrice(sellPrice, sellDate, market);
  return (effectiveSell - effectiveBuy) / effectiveBuy;
}
