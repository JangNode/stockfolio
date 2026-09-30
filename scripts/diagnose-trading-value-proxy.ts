/**
 * 디스포저블 진단(쓰기 없음): 2015~2022 기존 행처럼 trading_value가 0인 행에 쓰는 대체값
 * (종가×거래량)이 2023년 이후 실제 거래대금(KRX ACC_TRDVAL)과 얼마나 다른지, 그 차이가
 * 유동성 5억원 필터 판정을 얼마나 바꾸는지 표본(2023~올해 전 행)으로 확인한다.
 *
 * 실행: npm run diagnose:trading-value-proxy
 */

import { loadAllStockSeriesFromParquet, type StockDailyPriceRow } from "@/lib/stockDailyPricesStorage";
import { computeTrailingAvgTradingValue } from "@/lib/pitUniverse";
import { PIT_LIQUIDITY_LOOKBACK_DAYS, PIT_MIN_AVG_TRADING_VALUE_WON } from "@/lib/strategyBacktestSummaryConfig";

function percentile(sorted: Float64Array, p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

async function main(): Promise<void> {
  const seriesByCode = await loadAllStockSeriesFromParquet(2023, new Date().getUTCFullYear());

  const errors: number[] = [];
  let within10 = 0;
  let within20 = 0;
  let stockDays = 0;
  let trueEligible = 0;
  let proxyEligible = 0;
  let disagree = 0;

  for (const rows of seriesByCode.values()) {
    for (const r of rows) {
      if (r.tradingValue > 0 && r.volume > 0) {
        const err = Math.abs((r.closePrice * r.volume) / r.tradingValue - 1);
        errors.push(err);
        if (err <= 0.1) within10++;
        if (err <= 0.2) within20++;
      }
    }
    const proxyRows: StockDailyPriceRow[] = rows.map((r) => ({ ...r, tradingValue: 0 }));
    const trueAvg = computeTrailingAvgTradingValue(rows, PIT_LIQUIDITY_LOOKBACK_DAYS);
    const proxyAvg = computeTrailingAvgTradingValue(proxyRows, PIT_LIQUIDITY_LOOKBACK_DAYS);
    for (let i = 0; i < rows.length; i++) {
      if (!Number.isFinite(trueAvg[i])) continue;
      stockDays++;
      const t = trueAvg[i] >= PIT_MIN_AVG_TRADING_VALUE_WON;
      const p = proxyAvg[i] >= PIT_MIN_AVG_TRADING_VALUE_WON;
      if (t) trueEligible++;
      if (p) proxyEligible++;
      if (t !== p) disagree++;
    }
  }

  const sorted = Float64Array.from(errors).sort();
  console.log(`표본: ${errors.length}행 (2023~올해, 거래대금>0 & 거래량>0)`);
  console.log(
    `|종가×거래량 / 실제 거래대금 - 1|: 중앙값 ${(percentile(sorted, 0.5) * 100).toFixed(2)}%, ` +
      `p90 ${(percentile(sorted, 0.9) * 100).toFixed(2)}%, p99 ${(percentile(sorted, 0.99) * 100).toFixed(2)}%`
  );
  console.log(`±10% 이내 ${((within10 / errors.length) * 100).toFixed(1)}%, ±20% 이내 ${((within20 / errors.length) * 100).toFixed(1)}%`);
  console.log(
    `유동성 5억원 판정(종목-일 ${stockDays}건): 실제값 기준 편입 ${trueEligible}, 대체값 기준 편입 ${proxyEligible}, ` +
      `판정이 달라진 건 ${disagree}건(${((disagree / stockDays) * 100).toFixed(3)}%)`
  );
}

main().catch((error) => {
  console.error("진단 중 오류:", error);
  process.exit(1);
});
