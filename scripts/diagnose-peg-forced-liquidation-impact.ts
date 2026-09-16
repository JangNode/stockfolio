/**
 * PEG전략(peg_lynch) 백테스트에 대해, 미청산 포지션 강제 청산 수정(lib/backtest.ts
 * runBacktest, isForcedLiquidation) 적용 전/후 결과를 실측 비교하는 디스포저블 진단
 * 스크립트. 읽기 전용(DB에 아무것도 쓰지 않는다) — 확인 후 삭제 예정.
 *
 * "이전"은 별도 코드 경로를 새로 만들지 않고, 지금(수정 적용 후) 코드가 만든
 * trades에서 isForcedLiquidation인 거래만 제외해 재구성한다 — 이 수정은 기존
 * 거래를 바꾸지 않고 기간 끝 미청산 거래를 하나 추가만 하므로, "제외" 하면
 * 수정 전과 수학적으로 동일하다.
 *
 * 종목 풀: scripts/screen-all-stocks.ts의 discoverFundamentalCandidates()(2011~올해,
 * STOCK_DATA_CANDIDATE_MARKET_CAP_EOK 이상 시총 도달 이력)와 동일한 방식으로 구성한
 * 뒤, 같은 마스터 필터(스팩/리츠·ETF·ETN/신규상장/상장폐지 위험)를 적용한다 — 실제
 * peg_lynch 스크리닝이 쓰는 유니버스와 최대한 동일하게 맞춘다.
 * 기간: CUSTOM_BACKTEST_PERIOD_MONTHS 중 가장 긴 36개월(3년) — 재무 조건은 매일
 * 재평가되는 상태라 가격 히스토리 워밍업이 필요 없다(reversal_breakout과 다름).
 *
 *   npx tsx --conditions=react-server scripts/diagnose-peg-forced-liquidation-impact.ts
 */
import { getAllStocks, type StockEntry } from "@/lib/stockMaster";
import { discoverCandidateStockCodes, getDailyPriceSeries } from "@/lib/stockDailyPricesStorage";
import { loadFundamentalsSeriesWithListedShares } from "@/lib/stockFundamentals";
import { runBacktest, aggregateTrades, type DailyPrice, type BacktestTrade, type StrategyRule } from "@/lib/backtest";
import { STOCK_DATA_CANDIDATE_MARKET_CAP_EOK } from "@/lib/stockDataConfig";

const FUNDAMENTAL_CANDIDATE_START_YEAR = 2011;
const EXCLUDED_NAME_SUBSTRINGS = ["스팩"];
const EXCLUDED_PRODUCT_TYPES = new Set(["RT", "EF", "EN"]);
const MIN_LISTED_MONTHS = 6;
const PERIOD_MONTHS = 36;
const CONCURRENCY = 10;

function monthsSinceListing(listedDate: string | null, now: Date): number | null {
  if (!listedDate || listedDate.length !== 8) return null;
  const year = Number(listedDate.slice(0, 4));
  const month = Number(listedDate.slice(4, 6));
  const day = Number(listedDate.slice(6, 8));
  const listed = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(listed.getTime())) return null;
  return (now.getTime() - listed.getTime()) / (30.44 * 24 * 60 * 60 * 1000);
}

function filterByMaster(stocks: StockEntry[]): StockEntry[] {
  const now = new Date();
  return stocks.filter((stock) => {
    if (EXCLUDED_NAME_SUBSTRINGS.some((s) => stock.name.includes(s))) return false;
    if (EXCLUDED_PRODUCT_TYPES.has(stock.productType)) return false;
    if (stock.isTradingHalted || stock.isLiquidationTrading || stock.isAdministrativeIssue) return false;
    const months = monthsSinceListing(stock.listedDate, now);
    if (months !== null && months < MIN_LISTED_MONTHS) return false;
    return true;
  });
}

async function discoverFundamentalCandidates(): Promise<string[]> {
  const currentYear = new Date().getUTCFullYear();
  const years = Array.from(
    { length: currentYear - FUNDAMENTAL_CANDIDATE_START_YEAR + 1 },
    (_, i) => FUNDAMENTAL_CANDIDATE_START_YEAR + i
  );
  return discoverCandidateStockCodes(years, STOCK_DATA_CANDIDATE_MARKET_CAP_EOK);
}

function windowStartDate(months: number): string {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}

interface StockOutcome {
  code: string;
  before: ReturnType<typeof aggregateTrades>;
  after: ReturnType<typeof aggregateTrades>;
  trades: BacktestTrade[];
}

async function processStock(code: string, startDate: string): Promise<StockOutcome | null> {
  const [priceRows, fundamentalsData] = await Promise.all([
    getDailyPriceSeries(code, startDate, new Date().toISOString().slice(0, 10)),
    loadFundamentalsSeriesWithListedShares(code),
  ]);
  if (priceRows.length === 0) return null;

  const prices: DailyPrice[] = priceRows.map((row) => ({
    date: row.tradeDate,
    open: row.openPrice,
    high: row.openPrice > row.closePrice ? row.openPrice : row.closePrice,
    low: row.openPrice < row.closePrice ? row.openPrice : row.closePrice,
    close: row.closePrice,
    volume: row.volume,
    marketCapEok: row.marketCapEok,
    listedShares: row.listedShares,
  }));

  const rule: StrategyRule = { rule_type: "peg_lynch", rule_params: {} };
  const result = runBacktest(prices, rule, startDate, fundamentalsData.series, fundamentalsData.listedSharesByFiscalYear);
  if (result.insufficientData || result.tradeCount === 0) return null;

  const beforeTrades = result.trades.filter((t) => !t.isForcedLiquidation);
  return {
    code,
    before: aggregateTrades(beforeTrades),
    after: aggregateTrades(result.trades),
    trades: result.trades,
  };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function summarize(label: string, allTrades: BacktestTrade[]): void {
  const agg = aggregateTrades(allTrades);
  const returns = allTrades.map((t) => t.returnPct * 100);
  console.log(`--- ${label} ---`);
  console.log(`  거래수: ${agg.tradeCount}`);
  console.log(`  승률: ${(agg.winRate * 100).toFixed(1)}%`);
  console.log(`  전체 복리 수익률: ${agg.totalReturnPct.toFixed(2)}%`);
  console.log(`  평균 거래당 수익률: ${returns.length > 0 ? (returns.reduce((a, b) => a + b, 0) / returns.length).toFixed(2) : "0.00"}%`);
  console.log(`  중앙값 거래당 수익률: ${median(returns).toFixed(2)}%`);
  console.log(`  MDD: ${agg.mddPct.toFixed(2)}%`);
}

async function main(): Promise<void> {
  console.log("=== PEG(peg_lynch) 강제청산 수정 전/후 실측 비교 ===");
  console.log(`기간: 최근 ${PERIOD_MONTHS}개월`);

  const startDate = windowStartDate(PERIOD_MONTHS);

  const [allStocks, candidateCodes] = await Promise.all([getAllStocks(), discoverFundamentalCandidates()]);
  const survivors = filterByMaster(allStocks);
  const survivorCodes = new Set(survivors.map((s) => s.code));
  const candidates = candidateCodes.filter((code) => survivorCodes.has(code));

  console.log(`후보종목 ${candidateCodes.length}개 중 마스터 필터 통과 ${candidates.length}개`);

  const outcomes: StockOutcome[] = [];
  let completed = 0;
  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    const batch = candidates.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (code) => {
        try {
          return await processStock(code, startDate);
        } catch (error) {
          console.error(`  ${code} 처리 실패: ${error instanceof Error ? error.message : error}`);
          return null;
        }
      })
    );
    for (const r of results) if (r) outcomes.push(r);
    completed += batch.length;
    if (completed % 50 === 0 || completed === candidates.length) {
      console.log(`  [${completed}/${candidates.length}] 진행 중... (매칭 ${outcomes.length}종목)`);
    }
  }

  console.log(`매칭 종목: ${outcomes.length}개`);

  const beforeAllTrades = outcomes.flatMap((o) => o.trades.filter((t) => !t.isForcedLiquidation));
  const afterAllTrades = outcomes.flatMap((o) => o.trades);
  const forcedCount = afterAllTrades.filter((t) => t.isForcedLiquidation).length;

  console.log(`\n강제 청산 건수: ${forcedCount} / ${afterAllTrades.length}건 (${((forcedCount / afterAllTrades.length) * 100).toFixed(1)}%)`);

  summarize("수정 전(미청산 포지션 제외)", beforeAllTrades);
  summarize("수정 후(미청산 포지션 강제 청산 포함)", afterAllTrades);
}

main().catch((error) => {
  console.error("진단 스크립트 실행 중 오류:", error);
  process.exit(1);
});
