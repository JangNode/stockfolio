/**
 * (1회성 검증) 피터린치 PEG전략(peg_lynch) 판정 로직을 실데이터로 확인한다.
 * 검증 후 삭제 예정.
 */
import {
  runBacktest,
  matchesToday,
  computeEntryPlan,
  type StrategyRule,
  type DailyPrice,
} from "@/lib/backtest";
import { loadFundamentalsSeriesWithListedShares } from "@/lib/stockFundamentals";
import { getDailyPrice, getDailyPriceSeries } from "@/lib/stockDailyPricesStorage";
import { PEG_MAX_RATIO } from "@/lib/pegConfig";

const CODE = "005930";
const PEG_RULE: StrategyRule = { rule_type: "peg_lynch", rule_params: {} };

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
  console.log(`PEG전략 기준값: PEG <= ${PEG_MAX_RATIO}, 적자기업 제외`);

  const { series, listedSharesByFiscalYear } = await loadFundamentalsSeriesWithListedShares(CODE);
  console.log(`${CODE} 재무 이력: ${series.annual.map((a) => `FY${a.fiscalYear}(순이익:${a.netIncomeParent})`).join(", ")}`);
  console.log(`연도별 상장주식수:`, Object.fromEntries(listedSharesByFiscalYear));

  for (const checkDate of ["2026-08-27", "2024-03-15", "2023-03-15"]) {
    console.log(`\n=== ${checkDate} 기준 ===`);
    const priceRow = await getDailyPrice(CODE, checkDate);
    if (!priceRow) {
      console.log("  가격 없음(휴장/데이터 없음), 건너뜀");
      continue;
    }
    const prices = [toDailyPrice(priceRow)];
    const matched = matchesToday(prices, PEG_RULE, series, listedSharesByFiscalYear);
    console.log(`  matchesToday: ${matched}`);
    const entryPlan = computeEntryPlan(prices, PEG_RULE);
    console.log(`  진입가 계획:`, entryPlan);
  }

  console.log("\n=== 합성 실패 케이스 ===");
  // 적자기업(순이익 음수)
  const lossFundamentals = {
    annual: [{ fiscalYear: 2025, rceptNo: "x", rceptDate: "2026-03-10", netIncomeParent: -1000, equityParent: 10000 }],
    dividends: [],
  };
  const lossShares = new Map([[2025, 1000]]);
  const dummyPrice: DailyPrice = { date: "2026-08-27", open: 100, high: 100, low: 100, close: 100, volume: 0, marketCapEok: 100000, listedShares: 1000 };
  console.log(`적자기업 → matchesToday: ${matchesToday([dummyPrice], PEG_RULE, lossFundamentals, lossShares)} (기대: false)`);

  // 재무 데이터 자체가 없음(신규상장 시뮬레이션)
  const noFundSeries = { annual: [], dividends: [] };
  console.log(`재무 없음 → matchesToday: ${matchesToday([dummyPrice], PEG_RULE, noFundSeries, new Map())} (기대: false, 데이터 부족)`);

  // 정상 성장 + PEG 기준 이내(합성)
  const growthFundamentals = {
    annual: [
      { fiscalYear: 2020, rceptNo: "x", rceptDate: "2021-03-01", netIncomeParent: 1000, equityParent: 10000 },
      { fiscalYear: 2025, rceptNo: "y", rceptDate: "2026-03-01", netIncomeParent: 3000, equityParent: 20000 },
    ],
    dividends: [],
  };
  const growthShares = new Map([[2020, 1000], [2025, 1000]]);
  const cheapPrice: DailyPrice = { date: "2026-08-27", open: 5000, high: 5000, low: 5000, close: 5000, volume: 0, marketCapEok: 5000000, listedShares: 1000 };
  // EPS 2020=1, EPS 2025=3 → CAGR=(3/1)^(1/5)-1=24.57%. PER=5000/3=1666.67. PEG=1666.67/24.57=67.8 (매우 큼, 기준 초과)
  console.log(`고평가(PER 큼) → matchesToday: ${matchesToday([cheapPrice], PEG_RULE, growthFundamentals, growthShares)} (기대: false, PEG 기준 초과)`);

  const veryCheapPrice: DailyPrice = { date: "2026-08-27", open: 20, high: 20, low: 20, close: 20, volume: 0, marketCapEok: 20000, listedShares: 1000 };
  // PER=20/3=6.67, PEG=6.67/24.57=0.27 (<=1.0)
  console.log(`저평가(PER 작음) → matchesToday: ${matchesToday([veryCheapPrice], PEG_RULE, growthFundamentals, growthShares)} (기대: true, PEG 기준 이내)`);

  console.log("\n=== runBacktest 스모크 테스트(2020-01-01~2024-01-05) ===");
  const seriesRows = await getDailyPriceSeries(CODE, "2020-01-01", "2024-01-05");
  const seriesPrices = seriesRows.map(toDailyPrice);
  const result = runBacktest(seriesPrices, PEG_RULE, "2020-01-01", series, listedSharesByFiscalYear);
  console.log(`백테스트 결과: 거래 ${result.tradeCount}건, 수익률 ${result.totalReturnPct.toFixed(2)}%, 데이터부족 ${result.insufficientData}`);

  console.log("\n검증 완료.");
}

main().catch((error) => {
  console.error("검증 중 오류:", error);
  process.exit(1);
});
