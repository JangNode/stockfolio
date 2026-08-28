/**
 * (1회성 검증) PEG(피터 린치) 계산 로직을 실데이터로 확인한다. 검증 후 삭제 예정.
 */
import { loadFundamentalsSeries, computeEpsCagrAsOf } from "@/lib/stockFundamentals";
import { selectEpsCagrFiscalYears, computeEpsCagr, computePeg } from "@/lib/pegRatio";
import { PEG_GROWTH_LOOKBACK_YEARS } from "@/lib/pegConfig";

const CODE = "005930";

async function main(): Promise<void> {
  const series = await loadFundamentalsSeries(CODE);
  console.log(`${CODE} 재무 이력: ${series.annual.map((a) => `FY${a.fiscalYear}(${a.rceptDate})`).join(", ")}`);

  for (const asOfDate of ["2024-03-15", "2023-03-15", "2020-01-01", "2012-01-01"]) {
    console.log(`\n=== ${asOfDate} 기준 ===`);
    const pair = selectEpsCagrFiscalYears(series, asOfDate, PEG_GROWTH_LOOKBACK_YEARS);
    if (!pair) {
      console.log("  선택된 연도 쌍 없음(데이터 부족)");
      continue;
    }
    console.log(`  시작 FY${pair.start.fiscalYear}(순이익 ${pair.start.netIncomeParent}), 끝 FY${pair.end.fiscalYear}(순이익 ${pair.end.netIncomeParent})`);

    const result = await computeEpsCagrAsOf(CODE, asOfDate);
    console.log(`  computeEpsCagrAsOf 결과:`, result);

    // per=10 가정 시 PEG 수동 계산과 대조
    if (result?.growthPct != null) {
      const manualPeg = 10 / result.growthPct;
      const pegViaFn = computePeg(10, result.growthPct);
      console.log(`  PER=10 가정 PEG: 수동=${manualPeg.toFixed(4)}, computePeg=${pegViaFn?.toFixed(4)} (일치: ${Math.abs(manualPeg - (pegViaFn ?? NaN)) < 1e-9})`);
    }
  }

  console.log("\n=== 합성 케이스: 역성장(끝 EPS < 시작 EPS) → growthPct null ===");
  const declineGrowth = computeEpsCagr(
    { netIncomeParent: 1000, listedShares: 100 },
    { netIncomeParent: 500, listedShares: 100 },
    5
  );
  console.log(`역성장 결과: ${declineGrowth} (기대: null)`);

  console.log("\n=== 합성 케이스: 적자 연도 포함 → null ===");
  const lossGrowth = computeEpsCagr(
    { netIncomeParent: -100, listedShares: 100 },
    { netIncomeParent: 1000, listedShares: 100 },
    5
  );
  console.log(`적자 포함 결과: ${lossGrowth} (기대: null)`);

  console.log("\n=== 합성 케이스: 정상 성장 → 양수 growthPct, PEG 계산됨 ===");
  const normalGrowth = computeEpsCagr(
    { netIncomeParent: 1000, listedShares: 100 },
    { netIncomeParent: 2000, listedShares: 100 },
    5
  );
  const normalPeg = computePeg(15, normalGrowth);
  console.log(`정상 성장률: ${normalGrowth}, PER=15일 때 PEG: ${normalPeg}`);

  console.log("\n검증 완료.");
}

main().catch((error) => {
  console.error("검증 중 오류:", error);
  process.exit(1);
});
