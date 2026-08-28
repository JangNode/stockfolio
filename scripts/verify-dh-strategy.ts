/**
 * (1회성 검증) DH전략(dh_value_dividend) 판정 로직을 실데이터로 확인한다.
 * 검증 후 삭제 예정.
 */
import {
  runBacktest,
  matchesToday,
  computeEntryPlan,
  evaluateConsecutiveDividendYears,
  type StrategyRule,
  type DailyPrice,
} from "@/lib/backtest";
import { loadFundamentalsSeries, pickFundamentalsAsOf, pickDividendsPaidAsOf, computeValuationFromSeries } from "@/lib/stockFundamentals";
import { getDailyPrice, getDailyPriceSeries } from "@/lib/stockDailyPricesStorage";
import { DH_MIN_MARKET_CAP_EOK, DH_MAX_PER, DH_MAX_PBR, DH_MIN_CONSECUTIVE_DIVIDEND_YEARS } from "@/lib/dhStrategyConfig";

const CODE = "005930";
const DH_RULE: StrategyRule = { rule_type: "dh_value_dividend", rule_params: {} };

function toDailyPrice(row: { tradeDate: string; closePrice: number; marketCapEok: number; listedShares: number }): DailyPrice {
  return {
    date: row.tradeDate,
    open: row.closePrice,
    high: row.closePrice,
    low: row.closePrice,
    close: row.closePrice,
    volume: 0,
    marketCapEok: row.marketCapEok,
    listedShares: row.listedShares,
  };
}

async function main(): Promise<void> {
  console.log(`DH전략 기준값: 시가총액 >= ${DH_MIN_MARKET_CAP_EOK}억, PER <= ${DH_MAX_PER}, PBR <= ${DH_MAX_PBR}, 배당 연속 ${DH_MIN_CONSECUTIVE_DIVIDEND_YEARS}년`);

  const fundamentals = await loadFundamentalsSeries(CODE);
  console.log(`\n${CODE} 재무 ${fundamentals.annual.length}건, 배당 ${fundamentals.dividends.length}건`);

  console.log("\n=== 2023-03-15 단일 시점 판정 (matchesToday로 우회 확인) ===");
  const checkDate = "2023-03-15";
  const priceRow = await getDailyPrice(CODE, checkDate);
  if (!priceRow) throw new Error("가격 없음");
  const prices = [toDailyPrice(priceRow)];
  const fund = pickFundamentalsAsOf(fundamentals, checkDate);
  const { per, pbr } = computeValuationFromSeries(priceRow.closePrice, priceRow.listedShares, fund);
  const dividends = pickDividendsPaidAsOf(fundamentals, checkDate);
  const { consecutiveOk, paidYears } = evaluateConsecutiveDividendYears(dividends, checkDate, DH_MIN_CONSECUTIVE_DIVIDEND_YEARS);
  console.log(`시가총액 ${priceRow.marketCapEok}억, PER ${per}, PBR ${pbr}, 배당연속 ${consecutiveOk}(${paidYears.join(",")})`);
  const matched = matchesToday(prices, DH_RULE, fundamentals);
  console.log(`matchesToday 결과: ${matched} (기대: 시총/PER/PBR/배당 조건 전부 만족 시 true)`);

  const entryPlan = computeEntryPlan(prices, DH_RULE);
  console.log(`진입가 계획:`, entryPlan);

  console.log("\n=== 합성 실패 케이스(가짜 데이터로 각 조건 개별 위반 확인) ===");
  const fakeFundamentalsSeries = {
    annual: [{ fiscalYear: 2022, rceptNo: "x", rceptDate: "2023-03-07", netIncomeParent: 1_000_000_000, equityParent: 10_000_000_000 }],
    dividends: [] as { recordDate: string; cashDividendPerShare: number; payDate: string }[],
  };
  // 시가총액 미달
  const lowCapPrice: DailyPrice = { date: "2023-03-15", open: 1000, high: 1000, low: 1000, close: 1000, volume: 0, marketCapEok: 100, listedShares: 1_000_000 };
  console.log(`시가총액 미달(100억) → matchesToday: ${matchesToday([lowCapPrice], DH_RULE, fakeFundamentalsSeries)} (기대: false)`);
  // PER 초과 (close 매우 높게)
  const highPerPrice: DailyPrice = { date: "2023-03-15", open: 100000, high: 100000, low: 100000, close: 100000, volume: 0, marketCapEok: 100000, listedShares: 1_000_000 };
  console.log(`PER 초과 → matchesToday: ${matchesToday([highPerPrice], DH_RULE, fakeFundamentalsSeries)} (기대: false, 배당 이력도 없어 이중으로 false여야 함)`);
  // 재무 없음(신규상장 시뮬레이션)
  const noFundSeries = { annual: [], dividends: [] };
  console.log(`재무 없음 → matchesToday: ${matchesToday([lowCapPrice], DH_RULE, noFundSeries)} (기대: false, 시총부터 미달)`);

  console.log("\n=== runBacktest 스모크 테스트(2020-01-01~2024-01-05) ===");
  const seriesRows = await getDailyPriceSeries(CODE, "2020-01-01", "2024-01-05");
  const seriesPrices = seriesRows.map(toDailyPrice);
  console.log(`가격 시리즈 ${seriesPrices.length}행`);
  const result = runBacktest(seriesPrices, DH_RULE, "2020-01-01", fundamentals);
  console.log(`백테스트 결과: 거래 ${result.tradeCount}건, 수익률 ${result.totalReturnPct.toFixed(2)}%, 승률 ${(result.winRate * 100).toFixed(1)}%, 데이터부족 ${result.insufficientData}`);
  console.log(`거래 내역:`, result.trades);

  console.log("\n검증 완료.");
}

main().catch((error) => {
  console.error("검증 중 오류:", error);
  process.exit(1);
});
