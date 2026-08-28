/**
 * (1회성 검증) 커스텀 백테스트 펀더멘털 조건(lib/backtest.ts의 computeCustomFundamentalStates,
 * custom_composite의 fundamentals 카테고리)을 합성 케이스 + 실데이터로 확인한다.
 * 검증 후 삭제 예정.
 */
import {
  runBacktest,
  matchesToday,
  computeConsecutiveDividendYearsCount,
  type StrategyRule,
  type DailyPrice,
} from "@/lib/backtest";
import { loadFundamentalsSeriesWithListedShares, type FundamentalsSeries } from "@/lib/stockFundamentals";
import { getDailyPriceSeries } from "@/lib/stockDailyPricesStorage";

const CODE = "005930";

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
  console.log("=== 합성 케이스: 조건별 단독 판정 ===");

  // EPS 2020=1(=1000/1000), EPS 2025=3(=3000/1000) → CAGR=(3/1)^(1/5)-1≈24.57%.
  // 종가 5000 → PER=5000/3≈1666.67, BPS=20000/1000=20 → PBR=5000/20=250, PEG=1666.67/24.57≈67.8.
  const fundamentals: FundamentalsSeries = {
    annual: [
      { fiscalYear: 2020, rceptNo: "x", rceptDate: "2021-03-01", netIncomeParent: 1000, equityParent: 10000 },
      { fiscalYear: 2025, rceptNo: "y", rceptDate: "2026-03-01", netIncomeParent: 3000, equityParent: 20000 },
    ],
    dividends: [
      { recordDate: "2021-12-31", cashDividendPerShare: 100, payDate: "2022-04-15" },
      { recordDate: "2022-12-31", cashDividendPerShare: 100, payDate: "2023-04-15" },
      { recordDate: "2023-12-31", cashDividendPerShare: 100, payDate: "2024-04-15" },
      { recordDate: "2024-12-31", cashDividendPerShare: 100, payDate: "2025-04-15" },
      { recordDate: "2025-12-31", cashDividendPerShare: 100, payDate: "2026-04-15" },
    ],
  };
  const listedSharesByFiscalYear = new Map([
    [2020, 1000],
    [2025, 1000],
  ]);
  const price: DailyPrice = {
    date: "2026-08-27",
    open: 5000,
    high: 5000,
    low: 5000,
    close: 5000,
    volume: 0,
    marketCapEok: 500000,
    listedShares: 1000,
  };

  function rule(fc: NonNullable<Extract<StrategyRule, { rule_type: "custom_composite" }>["rule_params"]["fundamentals"]>): StrategyRule {
    return { rule_type: "custom_composite", rule_params: { fundamentals: fc } };
  }

  console.log(
    `시가총액>=10만억(현재 50만억) → ${matchesToday([price], rule({ market_cap_eok: { comparator: "gte", value: 100000 } }), fundamentals, listedSharesByFiscalYear)} (기대: true)`
  );
  console.log(
    `시가총액>=100만억(현재 50만억) → ${matchesToday([price], rule({ market_cap_eok: { comparator: "gte", value: 1000000 } }), fundamentals, listedSharesByFiscalYear)} (기대: false)`
  );
  console.log(
    `PER<=15(PER≈1666.67) → ${matchesToday([price], rule({ per: { comparator: "lte", value: 15 } }), fundamentals, listedSharesByFiscalYear)} (기대: false)`
  );
  console.log(
    `PER>100(PER≈1666.67) → ${matchesToday([price], rule({ per: { comparator: "gt", value: 100 } }), fundamentals, listedSharesByFiscalYear)} (기대: true)`
  );
  console.log(
    `PBR>200(PBR=250) → ${matchesToday([price], rule({ pbr: { comparator: "gt", value: 200 } }), fundamentals, listedSharesByFiscalYear)} (기대: true)`
  );
  console.log(
    `PEG<=1(PEG≈67.8) → ${matchesToday([price], rule({ peg: { comparator: "lte", value: 1 } }), fundamentals, listedSharesByFiscalYear)} (기대: false)`
  );
  console.log(
    `PEG>50(PEG≈67.8) → ${matchesToday([price], rule({ peg: { comparator: "gt", value: 50 } }), fundamentals, listedSharesByFiscalYear)} (기대: true)`
  );

  const divCount = computeConsecutiveDividendYearsCount(fundamentals.dividends, "2026-08-27");
  console.log(`computeConsecutiveDividendYearsCount(2026-08-27 기준) = ${divCount} (기대: 4 — 2025~2022년 연속, 2021년 끊김)`);
  console.log(
    `배당 연속 지급 연수>=4 → ${matchesToday([price], rule({ consecutive_dividend_years: { comparator: "gte", value: 4 } }), fundamentals, listedSharesByFiscalYear)} (기대: true)`
  );
  console.log(
    `배당 연속 지급 연수>=5 → ${matchesToday([price], rule({ consecutive_dividend_years: { comparator: "gte", value: 5 } }), fundamentals, listedSharesByFiscalYear)} (기대: false)`
  );

  // 최근 1년(2025-08-27~2026-08-27) 지급분은 2026-04-15(100) 1건뿐 → 배당수익률=100/5000*100=2%.
  console.log(
    `배당수익률>=1%(실제 2%) → ${matchesToday([price], rule({ dividend_yield_pct: { comparator: "gte", value: 1 } }), fundamentals, listedSharesByFiscalYear)} (기대: true)`
  );
  console.log(
    `배당수익률>=5%(실제 2%) → ${matchesToday([price], rule({ dividend_yield_pct: { comparator: "gte", value: 5 } }), fundamentals, listedSharesByFiscalYear)} (기대: false)`
  );

  console.log("\n=== 판정 불가(undefined) 케이스 ===");
  console.log(
    `재무 데이터 없음(series 자체 없음) → ${matchesToday([price], rule({ per: { comparator: "lte", value: 15 } }))} (기대: false, fundamentals 인자 자체를 안 넘김)`
  );
  const noShares: DailyPrice = { ...price, listedShares: undefined, marketCapEok: undefined };
  console.log(
    `시가총액/상장주식수 없는 날 → ${matchesToday([noShares], rule({ market_cap_eok: { comparator: "gte", value: 1 } }), fundamentals, listedSharesByFiscalYear)} (기대: false, undefined 판정)`
  );

  console.log("\n=== 실데이터: 이평 골든크로스 + PER 조건 조합(005930) ===");
  const { series: realFundamentals, listedSharesByFiscalYear: realShares } = await loadFundamentalsSeriesWithListedShares(CODE);
  const dhRows = await getDailyPriceSeries(CODE, "2023-11-01", "2024-06-28");
  const realPrices = dhRows.map(toDailyPrice);
  console.log(`${CODE} DH 가격 레이어 확보: ${realPrices.length}건(2023-11-01~2024-06-28)`);

  const comboRule: StrategyRule = {
    rule_type: "custom_composite",
    rule_params: {
      ma_cross: { short_period: 5, long_period: 20 },
      fundamentals: { per: { comparator: "lte", value: 20 } },
    },
  };
  const technicalOnlyRule: StrategyRule = {
    rule_type: "custom_composite",
    rule_params: { ma_cross: { short_period: 5, long_period: 20 } },
  };
  console.log(`기술 조건만(골든크로스 상태) → ${matchesToday(realPrices, technicalOnlyRule)}`);
  console.log(`기술+펀더멘털 조합(골든크로스 AND PER<=20) → ${matchesToday(realPrices, comboRule, realFundamentals, realShares)}`);

  console.log("\n=== runBacktest 스모크 테스트(2020-01-01~2024-01-05, 골든크로스 AND PER<=20) ===");
  const fullDhRows = await getDailyPriceSeries(CODE, "2019-11-01", "2024-01-05");
  const fullPrices = fullDhRows.map(toDailyPrice);
  const result = runBacktest(fullPrices, comboRule, "2020-01-01", realFundamentals, realShares);
  console.log(`백테스트 결과: 거래 ${result.tradeCount}건, 수익률 ${result.totalReturnPct.toFixed(2)}%, 데이터부족 ${result.insufficientData}`);

  console.log("\n검증 완료.");
}

main().catch((error) => {
  console.error("검증 중 오류:", error);
  process.exit(1);
});
