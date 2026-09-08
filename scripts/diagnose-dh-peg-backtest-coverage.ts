/**
 * (임시) DH전략/PEG전략 조건 튜닝 분석(0단계 커버리지 확인)용. DH/PEG전략 과거 신호
 * 재현 분석을 진행하기 전에, 표본이 의미 있는 백테스트를 하기에 충분한지 먼저
 * 확인한다:
 *
 * 1. stock_annual_fundamentals distinct stock_code 수.
 * 2. stock_dividend_history distinct stock_code 수 (DH전략은 배당 5년 연속 조건이
 *    필수라 이 숫자가 작으면 DH전략 분석 자체를 생략해야 한다).
 * 3. 재무+배당 데이터가 둘 다 있는 종목 수 (DH전략 후보 모수).
 * 4. PEG전략 후보 모수: 재무 데이터에서 5년 떨어진 회계연도 쌍(EPS CAGR 계산 가능)이
 *    존재하는 종목 수.
 * 5. 시세 데이터 교집합 샘플: 재무 커버리지가 있는 종목 중 일부를 뽑아
 *    getDailyPriceSeries로 실제 다년간 시세가 있는지, 최소/최대 거래일자가 뭔지 확인.
 *
 * 읽기 전용, DB만 조회하고 아무것도 쓰지 않는다. 확인 후 분석 스크립트/워크플로와
 * 함께 정리 PR로 삭제 예정.
 *
 * tsx --conditions=react-server scripts/diagnose-dh-peg-backtest-coverage.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getDailyPriceSeries } from "@/lib/stockDailyPricesStorage";
import { PEG_GROWTH_LOOKBACK_YEARS } from "@/lib/pegConfig";

const PAGE = 1000;

async function fetchAllRows<T>(
  table: string,
  columns: string
): Promise<T[]> {
  const rows: T[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabaseAdmin.from(table).select(columns).range(from, from + PAGE - 1);
    if (error) throw new Error(`${table} 조회 실패: ${error.message}`);
    rows.push(...((data ?? []) as T[]));
    if (!data || data.length < PAGE) break;
    from += PAGE;
  }
  return rows;
}

/** stockCode -> 공시된 회계연도 집합. */
function groupFiscalYearsByStock(rows: { stock_code: string; fiscal_year: number }[]): Map<string, Set<number>> {
  const byStock = new Map<string, Set<number>>();
  for (const row of rows) {
    let set = byStock.get(row.stock_code);
    if (!set) {
      set = new Set();
      byStock.set(row.stock_code, set);
    }
    set.add(row.fiscal_year);
  }
  return byStock;
}

/** fiscalYears 집합 안에 정확히 lookbackYears만큼 떨어진 연도 쌍이 하나라도 있는지. */
function hasEpsCagrPair(fiscalYears: Set<number>, lookbackYears: number): boolean {
  for (const year of fiscalYears) {
    if (fiscalYears.has(year - lookbackYears)) return true;
  }
  return false;
}

async function main(): Promise<void> {
  console.log("########## 0단계: DH/PEG전략 백테스트 커버리지 확인 ##########\n");

  console.log("--- 재무(stock_annual_fundamentals) 로드 중 ---");
  const fundamentalsRows = await fetchAllRows<{ stock_code: string; fiscal_year: number }>(
    "stock_annual_fundamentals",
    "stock_code, fiscal_year"
  );
  const fundamentalsByStock = groupFiscalYearsByStock(fundamentalsRows);
  console.log(`  총 행 수: ${fundamentalsRows.length}`);
  console.log(`  1. 재무 distinct 종목 수: ${fundamentalsByStock.size}`);

  console.log("\n--- 배당(stock_dividend_history) 로드 중 ---");
  const dividendRows = await fetchAllRows<{ stock_code: string }>("stock_dividend_history", "stock_code");
  const dividendStocks = new Set(dividendRows.map((r) => r.stock_code));
  console.log(`  총 행 수: ${dividendRows.length}`);
  console.log(`  2. 배당 distinct 종목 수: ${dividendStocks.size}`);

  const bothStocks = Array.from(fundamentalsByStock.keys()).filter((code) => dividendStocks.has(code));
  console.log(`\n  3. 재무+배당 둘 다 있는 종목 수(DH전략 후보 모수): ${bothStocks.length}`);

  const pegCandidates = Array.from(fundamentalsByStock.entries()).filter(([, years]) =>
    hasEpsCagrPair(years, PEG_GROWTH_LOOKBACK_YEARS)
  );
  console.log(
    `  4. PEG전략 후보 모수(${PEG_GROWTH_LOOKBACK_YEARS}년 떨어진 회계연도 쌍 존재): ${pegCandidates.length}`
  );

  console.log("\n--- 5. 시세 데이터 교집합 샘플 확인 ---");
  const today = new Date().toISOString().slice(0, 10);
  const startDate = "2011-01-01";

  // DH전략 후보(재무+배당 둘 다 있는 종목) 중 최대 5개, PEG전략 후보 중 재무만 있고
  // 배당은 없는 종목 중 최대 5개를 샘플로 뽑는다.
  const dhSample = bothStocks.slice(0, 5);
  const pegOnlySample = pegCandidates
    .map(([code]) => code)
    .filter((code) => !dividendStocks.has(code))
    .slice(0, 5);

  for (const [label, codes] of [
    ["DH전략 후보(재무+배당)", dhSample],
    ["PEG전략 후보(배당 없음)", pegOnlySample],
  ] as const) {
    console.log(`\n  [${label}] 샘플 ${codes.length}개`);
    for (const code of codes) {
      const series = await getDailyPriceSeries(code, startDate, today);
      if (series.length === 0) {
        console.log(`    ${code}: 시세 데이터 없음(재무는 있는데 시세가 없는 케이스)`);
        continue;
      }
      console.log(
        `    ${code}: ${series.length}건, ${series[0].tradeDate} ~ ${series[series.length - 1].tradeDate}`
      );
    }
  }

  console.log("\n=== 확인 종료 ===");
}

main().catch((error) => {
  console.error("확인 중 오류:", error);
  process.exit(1);
});
