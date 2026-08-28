/**
 * "실험실" 탭에서 요청한 커스텀 조건(custom_composite) 백테스트를 전체 종목 풀 대상으로
 * 실행하는 배치 스크립트. Vercel은 이 정도 분량(전종목 x 여러 페이지 일봉 조회)을 서버리스
 * 함수 시간 제한 안에 못 끝내므로, Next.js API 라우트가 custom_backtest_runs에 pending
 * 행을 만든 뒤 workflow_dispatch로 이 스크립트를 트리거한다(screen-all-stocks.ts/
 * screen-us-stocks.ts와 동일한 이유로 같은 패턴 재사용).
 *
 * 두 시장을 하나의 스크립트에서 다루되, 종목마스터/시세 조회와 잡주 필터링 기준은
 * 각 시장의 기존 스크리닝 배치(screen-all-stocks.ts/screen-us-stocks.ts)와 동일하게
 * 맞춘다 — 다만 전략 판정(matchesToday) 대신 종목별 runBacktest()를 돌려 매칭 종목과
 * 그 거래 내역 전체를 모은 뒤, 요약 통계는 custom_backtest_runs에, 무거운 원본 결과는
 * Supabase Storage(lib/customBacktestStorage.ts)에 나눠 저장한다.
 *
 * 필요 환경변수: KIS_APP_KEY, KIS_APP_SECRET, NEXT_PUBLIC_SUPABASE_URL,
 *   SUPABASE_SERVICE_ROLE_KEY, CUSTOM_BACKTEST_RUN_ID(대상 custom_backtest_runs.id)
 *   CUSTOM_BACKTEST_RUN_ID=<uuid> tsx --conditions=react-server scripts/run-custom-backtest.ts
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getStockPrice, getDailyPrices, getOverseasPriceDetail, getOverseasDailyPrices, getKisCallStats } from "@/lib/kis";
import { getAllStocks, type StockEntry } from "@/lib/stockMaster";
import { getAllOverseasStocks, type OverseasStockEntry } from "@/lib/stockMasterOverseas";
import { runBacktest, aggregateTrades, type CustomCompositeParams, type DailyPrice } from "@/lib/backtest";
import { uploadCustomBacktestResult, type CustomBacktestMatchedStock } from "@/lib/customBacktestStorage";
import { getDailyPriceSeries } from "@/lib/stockDailyPricesStorage";
import {
  loadFundamentalsSeries,
  loadFundamentalsSeriesWithListedShares,
  type FundamentalsSeries,
} from "@/lib/stockFundamentals";
import type { ListedSharesByFiscalYear } from "@/lib/pegRatio";
import type { Market } from "@/lib/market";

const BATCH_CONCURRENCY = 10;
const CALL_RETRY_COUNT = 2;
const CALL_RETRY_DELAY_MS = 2000;
const PROGRESS_LOG_INTERVAL = 50;

// 한 달을 거래일 기준 21일로 환산한다(기간 선택 UI가 "최근 1년/3년" 식으로 개월 수를 받음).
const TRADING_DAYS_PER_MONTH = 21;
// 지표(이평선/RSI/거래량 평균) 워밍업에 필요한 여유 봉 수.
const WARMUP_BUFFER_BARS = 20;
// lib/kis.ts getDailyPrices/getOverseasDailyPrices의 실질 상한(페이지당 100건 x 최대 8페이지).
const MAX_DAILY_ROWS = 800;

// 국내: scripts/screen-all-stocks.ts와 동일한 잡주 필터링 기준.
const KR_EXCLUDED_NAME_SUBSTRINGS = ["스팩"];
const KR_EXCLUDED_PRODUCT_TYPES = new Set(["RT", "EF", "EN"]);
const KR_MIN_LISTED_MONTHS = 6;
const KR_MIN_MARKET_CAP_EOK = 500;
const KR_MIN_PRICE_WON = 1000;

// 미국: scripts/screen-us-stocks.ts와 동일한 잡주 필터링 기준.
const US_SPAC_NAME_PATTERN = /\bacquisition\s+(corp|corporation|company|co)\b|\bspac\b/i;
const US_MIN_MARKET_CAP_USD = 500_000_000;
const US_MIN_PRICE_USD = 1;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** scripts/screen-all-stocks.ts와 동일한 동시성 유틸 — 각 배치 스크립트가
 * self-contained하게 유지되도록 의도적으로 별도 lib로 뽑지 않고 그대로 중복한다. */
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let nextIndex = 0;

  async function runOne(): Promise<void> {
    for (;;) {
      const index = nextIndex++;
      if (index >= items.length) return;
      await worker(items[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runOne));
}

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= CALL_RETRY_COUNT; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < CALL_RETRY_COUNT) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`    [재시도 ${attempt + 1}/${CALL_RETRY_COUNT}] ${label}: ${message}`);
        await sleep(CALL_RETRY_DELAY_MS);
      }
    }
  }

  throw lastError;
}

interface RunRow {
  id: string;
  market: Market;
  rule_params: CustomCompositeParams;
  period_months: number;
}

async function loadRun(runId: string): Promise<RunRow> {
  const { data, error } = await supabaseAdmin
    .from("custom_backtest_runs")
    .select("id, market, rule_params, period_months")
    .eq("id", runId)
    .single();
  if (error || !data) {
    throw new Error(`백테스트 요청(${runId}) 조회 실패: ${error?.message ?? "행을 찾을 수 없습니다"}`);
  }
  return data as RunRow;
}

async function markRunning(runId: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from("custom_backtest_runs")
    .update({ status: "running" })
    .eq("id", runId);
  if (error) throw new Error(`상태 갱신(running) 실패: ${error.message}`);
}

async function markFailed(runId: string, message: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from("custom_backtest_runs")
    .update({ status: "failed", error_message: message.slice(0, 2000), finished_at: new Date().toISOString() })
    .eq("id", runId);
  if (error) console.error(`상태 갱신(failed) 실패: ${error.message}`);
}

interface CompletedSummary {
  totalReturnPct: number;
  winRate: number;
  mddPct: number;
  matchedStockCount: number;
  tradeCount: number;
  storagePath: string;
}

async function markCompleted(runId: string, summary: CompletedSummary): Promise<void> {
  const { error } = await supabaseAdmin
    .from("custom_backtest_runs")
    .update({
      status: "completed",
      total_return_pct: summary.totalReturnPct,
      win_rate: summary.winRate,
      mdd_pct: summary.mddPct,
      matched_stock_count: summary.matchedStockCount,
      trade_count: summary.tradeCount,
      result_storage_path: summary.storagePath,
      finished_at: new Date().toISOString(),
    })
    .eq("id", runId);
  if (error) throw new Error(`상태 갱신(completed) 실패: ${error.message}`);
}

/** 요청된 기간(개월)과 조건이 필요로 하는 지표 워밍업 기간을 합쳐 종목당 조회할 일봉
 * 건수를 정한다. KIS 조회 상한(MAX_DAILY_ROWS)을 넘기지 않는다. */
function requiredDailyRows(periodMonths: number, ruleParams: CustomCompositeParams): number {
  const periodBars = periodMonths * TRADING_DAYS_PER_MONTH;
  const warmupBars =
    Math.max(ruleParams.ma_cross?.long_period ?? 0, ruleParams.rsi?.period ?? 0, ruleParams.volume_surge?.period ?? 0) +
    WARMUP_BUFFER_BARS;
  return Math.min(MAX_DAILY_ROWS, periodBars + warmupBars);
}

/** 상장일자(YYYYMMDD) 기준 상장 후 지난 개월 수. 파싱 실패 시 null(제외하지 않고 통과). */
function monthsSinceListing(listedDate: string | null, now: Date): number | null {
  if (!listedDate) return null;
  const year = Number(listedDate.slice(0, 4));
  const month = Number(listedDate.slice(4, 6));
  const day = Number(listedDate.slice(6, 8));
  if (year < 1950 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const listed = new Date(year, month - 1, day);
  if (Number.isNaN(listed.getTime())) return null;
  return (
    (now.getFullYear() - listed.getFullYear()) * 12 +
    (now.getMonth() - listed.getMonth()) -
    (now.getDate() < listed.getDate() ? 1 : 0)
  );
}

function filterKrByMaster(stocks: StockEntry[]): StockEntry[] {
  const now = new Date();
  return stocks.filter((stock) => {
    if (KR_EXCLUDED_NAME_SUBSTRINGS.some((s) => stock.name.includes(s))) return false;
    if (KR_EXCLUDED_PRODUCT_TYPES.has(stock.productType)) return false;
    if (stock.isTradingHalted || stock.isLiquidationTrading || stock.isAdministrativeIssue) return false;
    const months = monthsSinceListing(stock.listedDate, now);
    if (months !== null && months < KR_MIN_LISTED_MONTHS) return false;
    return true;
  });
}

async function filterKrByQuote(stocks: StockEntry[]): Promise<StockEntry[]> {
  const survivors: StockEntry[] = [];
  let completed = 0;

  await runWithConcurrency(stocks, BATCH_CONCURRENCY, async (stock) => {
    try {
      const price = await withRetry(() => getStockPrice(stock.code, "batch"), `${stock.code}(${stock.name}) 시세 조회`);
      if (price.currentPrice >= KR_MIN_PRICE_WON && price.marketCapEok >= KR_MIN_MARKET_CAP_EOK) {
        survivors.push(stock);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`    ${stock.code}(${stock.name}) 시세 조회 실패, 건너뜁니다: ${message}`);
    } finally {
      completed++;
      if (completed === 1 || completed % PROGRESS_LOG_INTERVAL === 0 || completed === stocks.length) {
        console.log(`  [${completed}/${stocks.length}] 시세 필터 진행 중...`);
      }
    }
  });

  return survivors;
}

function filterUsByMaster(stocks: OverseasStockEntry[]): OverseasStockEntry[] {
  return stocks.filter((stock) => !US_SPAC_NAME_PATTERN.test(stock.name));
}

async function filterUsByQuote(stocks: OverseasStockEntry[]): Promise<OverseasStockEntry[]> {
  const survivors: OverseasStockEntry[] = [];
  let completed = 0;

  await runWithConcurrency(stocks, BATCH_CONCURRENCY, async (stock) => {
    try {
      const detail = await withRetry(
        () => getOverseasPriceDetail(stock.exchange, stock.code, "batch"),
        `${stock.code}(${stock.name}) 시세상세 조회`
      );
      if (detail.currentPrice >= US_MIN_PRICE_USD && detail.marketCap >= US_MIN_MARKET_CAP_USD) {
        survivors.push(stock);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`    ${stock.code}(${stock.name}) 시세상세 조회 실패, 건너뜁니다: ${message}`);
    } finally {
      completed++;
      if (completed === 1 || completed % PROGRESS_LOG_INTERVAL === 0 || completed === stocks.length) {
        console.log(`  [${completed}/${stocks.length}] 시세 필터 진행 중...`);
      }
    }
  });

  return survivors;
}

interface PriceEntry {
  name: string;
  prices: DailyPrice[];
}

async function collectKrDailyPrices(stocks: StockEntry[], targetRows: number): Promise<Map<string, PriceEntry>> {
  const priceByCode = new Map<string, PriceEntry>();
  let completed = 0;

  await runWithConcurrency(stocks, BATCH_CONCURRENCY, async (stock) => {
    try {
      const prices = await withRetry(
        () => getDailyPrices(stock.code, "D", targetRows, "batch"),
        `${stock.code}(${stock.name}) 일봉 조회`
      );
      if (prices.length > 0) priceByCode.set(stock.code, { name: stock.name, prices });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`    ${stock.code}(${stock.name}) 일봉 조회 실패, 건너뜁니다: ${message}`);
    } finally {
      completed++;
      if (completed === 1 || completed % PROGRESS_LOG_INTERVAL === 0 || completed === stocks.length) {
        console.log(`  [${completed}/${stocks.length}] 일봉 수집 중...`);
      }
    }
  });

  return priceByCode;
}

async function collectUsDailyPrices(stocks: OverseasStockEntry[], targetRows: number): Promise<Map<string, PriceEntry>> {
  const priceByCode = new Map<string, PriceEntry>();
  let completed = 0;

  await runWithConcurrency(stocks, BATCH_CONCURRENCY, async (stock) => {
    try {
      const prices = await withRetry(
        () => getOverseasDailyPrices(stock.exchange, stock.code, "D", targetRows, "batch"),
        `${stock.code}(${stock.name}) 일봉 조회`
      );
      if (prices.length > 0) priceByCode.set(stock.code, { name: stock.name, prices });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`    ${stock.code}(${stock.name}) 일봉 조회 실패, 건너뜁니다: ${message}`);
    } finally {
      completed++;
      if (completed === 1 || completed % PROGRESS_LOG_INTERVAL === 0 || completed === stocks.length) {
        console.log(`  [${completed}/${stocks.length}] 일봉 수집 중...`);
      }
    }
  });

  return priceByCode;
}

async function collectUniverse(
  market: Market,
  targetRows: number
): Promise<Map<string, PriceEntry>> {
  if (market === "KR") {
    console.log("=== 국내 전종목 조회 ===");
    const all = await getAllStocks();
    const survivors = filterKrByMaster(all);
    console.log(`마스터 필터: ${all.length}개 → ${survivors.length}개`);
    const quoted = await filterKrByQuote(survivors);
    console.log(`시세 필터: ${survivors.length}개 → ${quoted.length}개`);
    return collectKrDailyPrices(quoted, targetRows);
  }

  console.log("=== 미국 전종목 조회 ===");
  const all = await getAllOverseasStocks();
  const survivors = filterUsByMaster(all);
  console.log(`마스터 필터: ${all.length}개 → ${survivors.length}개`);
  const quoted = await filterUsByQuote(survivors);
  console.log(`시세 필터: ${survivors.length}개 → ${quoted.length}개`);
  return collectUsDailyPrices(quoted, targetRows);
}

/** KIS 일봉 배열(prices)에 DH 가격 레이어(시가총액/상장주식수)를 날짜로 매칭해
 * 덮어씌운다 — OHLC/거래량 등 기존 필드는 그대로 두고 marketCapEok/listedShares만
 * 채운다("전량 교체"가 아니라 "병합"인 이유는 volume_surge 등 기술 조건이 KIS의 실제
 * 거래량을 그대로 써야 하기 때문). DH 레이어가 그 날짜를 아예 커버하지 않으면(백필
 * 하한 미달 등) 그 날은 marketCapEok/listedShares가 undefined로 남아, 펀더멘털 조건
 * 판정이 그 날만 point-in-time 규칙에 따라 자연스럽게 undefined(판정 불가)로
 * 떨어진다. */
async function mergeDhPriceFields(stockCode: string, prices: DailyPrice[]): Promise<DailyPrice[]> {
  if (prices.length === 0) return prices;

  const dhRows = await getDailyPriceSeries(stockCode, prices[0].date, prices[prices.length - 1].date);
  const dhByDate = new Map(dhRows.map((row) => [row.tradeDate, row]));

  return prices.map((p) => {
    const dhRow = dhByDate.get(p.date);
    if (!dhRow) return p;
    return { ...p, marketCapEok: dhRow.marketCapEok, listedShares: dhRow.listedShares };
  });
}

interface FundamentalsForStock {
  series: FundamentalsSeries;
  listedSharesByFiscalYear: ListedSharesByFiscalYear | undefined;
}

/** rule_params.fundamentals.peg가 지정된 경우에만 연도별 상장주식수까지 함께
 * 로드한다(EPS CAGR 계산에 필요 — peg_lynch 전략과 동일한 이유). */
async function loadFundamentalsForStock(stockCode: string, needsListedShares: boolean): Promise<FundamentalsForStock> {
  if (needsListedShares) {
    return loadFundamentalsSeriesWithListedShares(stockCode);
  }
  const series = await loadFundamentalsSeries(stockCode);
  return { series, listedSharesByFiscalYear: undefined };
}

async function main(): Promise<void> {
  const runId = process.env.CUSTOM_BACKTEST_RUN_ID;
  if (!runId) throw new Error("CUSTOM_BACKTEST_RUN_ID 환경변수가 필요합니다.");

  console.log(`커스텀 백테스트 배치 시작: ${runId}`);
  const run = await loadRun(runId);
  await markRunning(runId);

  try {
    const rule = { rule_type: "custom_composite" as const, rule_params: run.rule_params };
    const targetRows = requiredDailyRows(run.period_months, run.rule_params);
    const periodBars = run.period_months * TRADING_DAYS_PER_MONTH;
    console.log(
      `대상 시장: ${run.market}, 기간: ${run.period_months}개월(약 ${periodBars}거래일), 종목당 일봉 ${targetRows}건`
    );

    const priceByCode = await collectUniverse(run.market, targetRows);
    console.log(`일봉 확보: ${priceByCode.size}개 종목`);

    // 펀더멘털 조건은 스키마 단계(lib/customBacktestRequest.ts)에서부터 market="KR"에만
    // 허용된다 — US 요청엔 fundamentals가 아예 없으므로 이 분기가 항상 false라 US
    // 흐름은 이전과 동일하게 동작한다.
    const fundamentalsRequested = run.market === "KR" && run.rule_params.fundamentals !== undefined;
    const needsListedShares = fundamentalsRequested && run.rule_params.fundamentals?.peg !== undefined;
    if (fundamentalsRequested) {
      console.log("펀더멘털 조건이 지정돼 있어 종목별로 DH 가격 레이어(시가총액/상장주식수) + 재무 이력을 함께 조회합니다.");
    }

    console.log("=== 종목별 백테스트 판정 ===");
    const matchedStocks: CustomBacktestMatchedStock[] = [];
    let completed = 0;

    for (const [stockCode, { name: stockName, prices: kisPrices }] of priceByCode) {
      completed++;
      if (completed === 1 || completed % PROGRESS_LOG_INTERVAL === 0 || completed === priceByCode.size) {
        console.log(`  [${completed}/${priceByCode.size}] 백테스트 판정 중... (매칭 ${matchedStocks.length}건)`);
      }

      const windowStartIndex = Math.max(0, kisPrices.length - periodBars);
      const windowStartDate = kisPrices[windowStartIndex]?.date ?? kisPrices[0]?.date;
      if (!windowStartDate) continue;

      let prices = kisPrices;
      let fundamentals: FundamentalsSeries | undefined;
      let listedSharesByFiscalYear: ListedSharesByFiscalYear | undefined;

      if (fundamentalsRequested) {
        try {
          const [merged, fundamentalsData] = await Promise.all([
            mergeDhPriceFields(stockCode, kisPrices),
            loadFundamentalsForStock(stockCode, needsListedShares),
          ]);
          prices = merged;
          fundamentals = fundamentalsData.series;
          listedSharesByFiscalYear = fundamentalsData.listedSharesByFiscalYear;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`    ${stockCode}(${stockName}) 펀더멘털 조회 실패, 건너뜁니다: ${message}`);
          continue;
        }
      }

      const result = runBacktest(prices, rule, windowStartDate, fundamentals, listedSharesByFiscalYear);
      if (result.insufficientData || result.tradeCount === 0) continue;

      matchedStocks.push({
        stockCode,
        stockName,
        trades: result.trades,
        totalReturnPct: result.totalReturnPct,
        tradeCount: result.tradeCount,
        winRate: result.winRate,
      });
    }

    console.log(`백테스트 판정 완료: 매칭 ${matchedStocks.length}개 종목`);

    const allTrades = matchedStocks.flatMap((s) => s.trades);
    const aggregate = aggregateTrades(allTrades);

    const storagePath = await uploadCustomBacktestResult(runId, { matchedStocks });

    await markCompleted(runId, {
      totalReturnPct: aggregate.totalReturnPct,
      winRate: aggregate.winRate,
      mddPct: aggregate.mddPct,
      matchedStockCount: matchedStocks.length,
      tradeCount: aggregate.tradeCount,
      storagePath,
    });

    const kisStats = getKisCallStats();
    console.log(
      `커스텀 백테스트 배치 종료: 매칭 ${matchedStocks.length}개 종목, 거래 ${aggregate.tradeCount}건, ` +
        `수익률 ${aggregate.totalReturnPct.toFixed(2)}%, 승률 ${(aggregate.winRate * 100).toFixed(1)}%, ` +
        `MDD ${aggregate.mddPct.toFixed(2)}% (KIS 호출 ${kisStats.total}건)`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markFailed(runId, message);
    throw error;
  }
}

main().catch((error) => {
  console.error("배치 실행 중 오류가 발생했습니다:", error);
  process.exit(1);
});
