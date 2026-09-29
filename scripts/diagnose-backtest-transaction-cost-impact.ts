/**
 * 디스포저블 진단: "장기 백테스트(2016~오늘)" 결과(strategy_backtest_summary)에
 * 거래비용(수수료/증권거래세/슬리피지)이 전혀 반영돼 있지 않다는 조사 결과(2026-09-29)를
 * 바탕으로, 비용을 반영하면 CAGR/MDD/승률/손익비가 얼마나 바뀌는지 5개 전략 모두
 * 추정한다. scripts/compute-strategy-backtest-summary.ts와 동일한 유니버스/rule_params/
 * runBacktest를 그대로 재사용해 "비용 반영 전(현재 프로덕션과 동일)"과 "비용 반영 후"를
 * 나란히 계산해서 출력한다. DB에는 쓰지 않는다(진단 전용, insert 없음).
 *
 * 비용 가정(2026-09-29 사용자 지정, 진단용 — 최종 반영값이 아니다):
 * - 매매 수수료: 매수·매도 각 0.015% (거래대금 기준)
 * - 슬리피지: 매수·매도 각 0.1% (불리한 방향 — 매수는 종가보다 비싸게, 매도는
 *   종가보다 싸게 체결된다고 가정)
 * - 증권거래세: 매도 시, 매도 연도의 실제 세율. 웹 검색으로 확인한 연도별 매도
 *   총세율(거래세+농특세 합산, 코스피/코스닥 — 조사 결과 두 시장이 매년 동일한
 *   총세율을 유지해와서 시장 구분 없이 연도만으로 적용 가능함을 확인):
 *     2016~2018: 0.30%  (26년간 유지되던 세율)
 *     2019: 0.25%로 인하(2019-06 시행, 연도 단위로 단순화 — 상반기 실제는 0.30%였음, 오차 있음)
 *     2020: 0.25%
 *     2021~2022: 0.23%
 *     2023: 0.20%
 *     2024: 0.18%
 *     2025: 0.15%
 *     2026~: 0.20% (2026-01-02 시행, 금투세 폐지로 2023년 수준 환원)
 *   출처: 각 증권사 공지(대신증권/키움/삼성증권 2025·2026년 세율 인하·인상 안내),
 *   한경/이데일리 기사. 2019년 상반기·하반기 구분은 생략(연도 단위 단순화) — 이
 *   부분만 오차가 있을 수 있고, 그 외 연도는 연중 세율 변경이 없었다.
 *
 * 실행: tsx --conditions=react-server scripts/diagnose-backtest-transaction-cost-impact.ts
 * 필요 환경변수: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  discoverCandidateStockCodes,
  getDailyPriceSeries,
  type StockDailyPriceRow,
} from "@/lib/stockDailyPricesStorage";
import { loadFundamentalsSeriesWithListedShares, type FundamentalsSeries } from "@/lib/stockFundamentals";
import {
  runBacktest,
  aggregateTrades,
  type StrategyRule,
  type DailyPrice,
  type BacktestTrade,
  type MaCrossParams,
  type MinerviniParams,
} from "@/lib/backtest";
import { STOCK_DATA_CANDIDATE_MARKET_CAP_EOK } from "@/lib/stockDataConfig";
import type { ListedSharesByFiscalYear } from "@/lib/pegRatio";
import {
  STRATEGY_BACKTEST_WINDOW_START_YEAR,
  STRATEGY_BACKTEST_TARGET_RULE_TYPES,
  FALLBACK_MA_CROSS_PARAMS,
  FALLBACK_MINERVINI_PARAMS,
} from "@/lib/strategyBacktestSummaryConfig";
import {
  accumulateStockDailyReturns,
  computeEqualWeightDailyReturns,
  computeCumulativeAndMdd,
  computeCagrPct,
  type DailyStockReturns,
  type StockContribution,
} from "@/lib/strategyBacktestSummary";

const CURRENT_YEAR = new Date().getUTCFullYear();
const TODAY = new Date().toISOString().slice(0, 10);
const PERIOD_START_DATE = `${STRATEGY_BACKTEST_WINDOW_START_YEAR}-01-01`;
const PRICE_FETCH_START_DATE = "2014-01-01";

const BATCH_CONCURRENCY = 10;
const PROGRESS_LOG_INTERVAL = 200;

const TARGET_RULE_TYPES = STRATEGY_BACKTEST_TARGET_RULE_TYPES;
type TargetRuleType = (typeof TARGET_RULE_TYPES)[number];

// --- 비용 가정 (사용자 지정, 진단 전용) ---
const FEE_BUY_PCT = 0.00015;
const FEE_SELL_PCT = 0.00015;
const SLIPPAGE_BUY_PCT = 0.001;
const SLIPPAGE_SELL_PCT = 0.001;

const TAX_RATE_BY_YEAR: Record<number, number> = {
  2016: 0.003,
  2017: 0.003,
  2018: 0.003,
  2019: 0.0025,
  2020: 0.0025,
  2021: 0.0023,
  2022: 0.0023,
  2023: 0.002,
  2024: 0.0018,
  2025: 0.0015,
  2026: 0.002,
};

function taxRateForYear(year: number): number {
  if (year in TAX_RATE_BY_YEAR) return TAX_RATE_BY_YEAR[year];
  // 표에 없는 미래 연도는 최신 확인된 세율을 그대로 쓴다(추정치 성격 보존).
  return TAX_RATE_BY_YEAR[2026];
}

/** 매수 체결가에 곱하는 배수(슬리피지+수수료로 불리하게 보정). */
function buyCostFactor(): number {
  return (1 + SLIPPAGE_BUY_PCT) * (1 + FEE_BUY_PCT);
}

/** 매도 체결가에 곱하는 배수(슬리피지+수수료+증권거래세로 불리하게 보정). sellDate 연도의
 * 실제 세율을 적용한다. */
function sellCostFactor(sellDate: string): number {
  const year = Number(sellDate.slice(0, 4));
  const taxRate = taxRateForYear(year);
  return (1 - SLIPPAGE_SELL_PCT) * (1 - FEE_SELL_PCT - taxRate);
}

/** 거래 하나의 비용 반영 후 수익률(비율, 0.01=1%). 매수가/매도가에 위 배수를 곱해
 * "실제 체결됐을 가격"으로 보정한 뒤 그 사이 수익률을 구한다. */
function adjustedTradeReturnPct(trade: BacktestTrade): number {
  const effectiveBuy = trade.buyPrice * buyCostFactor();
  const effectiveSell = trade.sellPrice * sellCostFactor(trade.sellDate);
  return (effectiveSell - effectiveBuy) / effectiveBuy;
}

async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
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

function toDailyPrice(row: StockDailyPriceRow): DailyPrice {
  return {
    date: row.tradeDate,
    open: row.openPrice,
    high: row.highPrice,
    low: row.lowPrice,
    close: row.closePrice,
    volume: row.volume,
    marketCapEok: row.marketCapEok,
    listedShares: row.listedShares,
  };
}

async function loadActiveRuleParams(
  ruleType: "ma_cross" | "minervini_trend_template"
): Promise<Record<string, unknown> | null> {
  const { data, error } = await supabaseAdmin
    .from("strategies")
    .select("rule_params")
    .eq("rule_type", ruleType)
    .eq("market", "KR")
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`${ruleType} 대표 전략 조회 실패: ${error.message}`);
  return (data?.rule_params as Record<string, unknown>) ?? null;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * 날짜 단위 동일가중 수익률 체인에 거래비용을 주입한 버전. accumulateStockDailyReturns와
 * 똑같이 매수 다음 거래일~매도일까지 종가 대비 종가 수익률을 쌓되, 보유 구간의 첫째 날
 * 수익률엔 매수비용 배수로, 마지막 날 수익률엔 매도비용 배수로 나눗셈/곱셈을 적용해
 * "그 날 실제 체결가 기준" 수익률로 보정한다(첫날=마지막날인 1거래일 보유는 둘 다 적용).
 * 원본 함수는 buyPrice/sellPrice를 아예 참조하지 않는 순수 종가 체인이라 비용을 반영할
 * 자리가 없었다 — 이 진단에서 "수정 계획"에 넣을 접근을 미리 검증한다.
 */
function accumulateStockDailyReturnsWithCost(
  dailyReturns: DailyStockReturns,
  contributions: Map<string, StockContribution>,
  stockCode: string,
  prices: DailyPrice[],
  trades: BacktestTrade[],
  windowStartDate: string
): void {
  if (trades.length === 0) return;

  const dateIndex = new Map(prices.map((p, i) => [p.date, i]));
  const contribution = contributions.get(stockCode) ?? { stockCode, multiplier: 1, tradeCount: 0 };
  contribution.tradeCount += trades.length;

  for (const trade of trades) {
    const buyIdx = dateIndex.get(trade.buyDate);
    const sellIdx = dateIndex.get(trade.sellDate);
    if (buyIdx === undefined || sellIdx === undefined) continue;

    const buyFactor = buyCostFactor();
    const sellFactor = sellCostFactor(trade.sellDate);

    for (let i = buyIdx + 1; i <= sellIdx; i++) {
      const date = prices[i].date;
      if (date < windowStartDate) continue;

      let dailyReturn = (prices[i].close - prices[i - 1].close) / prices[i - 1].close;
      const isFirstDay = i === buyIdx + 1;
      const isLastDay = i === sellIdx;
      let multiplier = 1 + dailyReturn;
      if (isFirstDay) multiplier /= buyFactor;
      if (isLastDay) multiplier *= sellFactor;
      dailyReturn = multiplier - 1;

      const list = dailyReturns.get(date);
      if (list) list.push({ stockCode, returnPct: dailyReturn });
      else dailyReturns.set(date, [{ stockCode, returnPct: dailyReturn }]);

      contribution.multiplier *= 1 + dailyReturn;
    }
  }

  contributions.set(stockCode, contribution);
}

interface RuleTypeAccumulator {
  trades: BacktestTrade[];
  dailyReturns: DailyStockReturns;
  dailyReturnsWithCost: DailyStockReturns;
}

function createAccumulator(): RuleTypeAccumulator {
  return { trades: [], dailyReturns: new Map(), dailyReturnsWithCost: new Map() };
}

function summarizeTrades(trades: BacktestTrade[], useCost: boolean) {
  const returnPctList = trades.map((t) => (useCost ? adjustedTradeReturnPct(t) : t.returnPct) * 100);
  const winReturns = returnPctList.filter((v) => v > 0);
  const lossReturns = returnPctList.filter((v) => v <= 0);
  const avgWinPct = winReturns.length > 0 ? winReturns.reduce((s, v) => s + v, 0) / winReturns.length : null;
  const avgLossPct = lossReturns.length > 0 ? lossReturns.reduce((s, v) => s + v, 0) / lossReturns.length : null;
  const payoffRatio =
    avgWinPct !== null && avgLossPct !== null && avgLossPct !== 0 ? avgWinPct / Math.abs(avgLossPct) : null;
  const avgReturnPct = returnPctList.reduce((s, v) => s + v, 0) / returnPctList.length;
  const medianReturnPct = median(returnPctList);
  const winRate = trades.length > 0 ? winReturns.length / trades.length : 0;

  return { avgReturnPct, medianReturnPct, winRate, avgWinPct, avgLossPct, payoffRatio };
}

async function main(): Promise<void> {
  console.log(`거래비용 반영 영향 진단 시작: ${new Date().toISOString()}`);
  console.log(
    `비용 가정: 수수료 매수/매도 각 ${(FEE_BUY_PCT * 100).toFixed(3)}%, ` +
      `슬리피지 매수/매도 각 ${(SLIPPAGE_BUY_PCT * 100).toFixed(2)}%, 증권거래세 연도별 실제 세율`
  );

  const [maCrossActive, minerviniActive] = await Promise.all([
    loadActiveRuleParams("ma_cross"),
    loadActiveRuleParams("minervini_trend_template"),
  ]);
  const maCrossParams = (maCrossActive as unknown as MaCrossParams | null) ?? FALLBACK_MA_CROSS_PARAMS;
  const minerviniParams = (minerviniActive as unknown as MinerviniParams | null) ?? FALLBACK_MINERVINI_PARAMS;

  const RULES: Record<TargetRuleType, StrategyRule> = {
    ma_cross: { rule_type: "ma_cross", rule_params: maCrossParams },
    minervini_trend_template: { rule_type: "minervini_trend_template", rule_params: minerviniParams },
    reversal_breakout: { rule_type: "reversal_breakout", rule_params: {} },
    reversal_breakout_v2: { rule_type: "reversal_breakout_v2", rule_params: {} },
    peg_lynch: { rule_type: "peg_lynch", rule_params: {} },
  };

  const discoveryYears = Array.from(
    { length: CURRENT_YEAR - STRATEGY_BACKTEST_WINDOW_START_YEAR + 1 },
    (_, i) => STRATEGY_BACKTEST_WINDOW_START_YEAR + i
  );
  const universe = await discoverCandidateStockCodes(discoveryYears, STOCK_DATA_CANDIDATE_MARKET_CAP_EOK);
  console.log(`유니버스: ${universe.length}개 종목`);

  const accumulators: Record<TargetRuleType, RuleTypeAccumulator> = {
    ma_cross: createAccumulator(),
    minervini_trend_template: createAccumulator(),
    reversal_breakout: createAccumulator(),
    reversal_breakout_v2: createAccumulator(),
    peg_lynch: createAccumulator(),
  };

  let completed = 0;
  await runWithConcurrency(universe, BATCH_CONCURRENCY, async (stockCode) => {
    try {
      const priceRows = await getDailyPriceSeries(stockCode, PRICE_FETCH_START_DATE, TODAY);
      if (priceRows.length === 0) return;

      const prices = priceRows.map(toDailyPrice);

      let fundamentals: FundamentalsSeries | undefined;
      let listedSharesByFiscalYear: ListedSharesByFiscalYear | undefined;
      try {
        const loaded = await loadFundamentalsSeriesWithListedShares(stockCode);
        fundamentals = loaded.series;
        listedSharesByFiscalYear = loaded.listedSharesByFiscalYear;
      } catch {
        // peg_lynch만 영향(compute-strategy-backtest-summary.ts와 동일하게 조용히 건너뜀).
      }

      for (const ruleType of TARGET_RULE_TYPES) {
        const needsFundamentals = ruleType === "peg_lynch";
        if (needsFundamentals && !fundamentals) continue;

        const result = runBacktest(
          prices,
          RULES[ruleType],
          PERIOD_START_DATE,
          needsFundamentals ? fundamentals : undefined,
          needsFundamentals ? listedSharesByFiscalYear : undefined
        );
        if (result.insufficientData || result.trades.length === 0) continue;

        const acc = accumulators[ruleType];
        acc.trades.push(...result.trades);
        accumulateStockDailyReturns(acc.dailyReturns, new Map(), stockCode, prices, result.trades, PERIOD_START_DATE);
        accumulateStockDailyReturnsWithCost(
          acc.dailyReturnsWithCost,
          new Map(),
          stockCode,
          prices,
          result.trades,
          PERIOD_START_DATE
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  ${stockCode} 처리 실패, 건너뜁니다: ${message}`);
    } finally {
      completed++;
      if (completed === 1 || completed % PROGRESS_LOG_INTERVAL === 0 || completed === universe.length) {
        console.log(`  [${completed}/${universe.length}] 종목 처리 중...`);
      }
    }
  });

  console.log("\n=== rule_type별 비용 반영 전/후 비교 ===");
  for (const ruleType of TARGET_RULE_TYPES) {
    const acc = accumulators[ruleType];
    if (acc.trades.length === 0) {
      console.log(`  [${ruleType}] 거래 없음 — 건너뜀`);
      continue;
    }

    const aggregateRaw = aggregateTrades(acc.trades);

    const before = summarizeTrades(acc.trades, false);
    const after = summarizeTrades(acc.trades, true);

    const dailyRaw = computeEqualWeightDailyReturns(acc.dailyReturns);
    const { totalReturnPct: totalRaw, mddPct: mddRaw } = computeCumulativeAndMdd(dailyRaw);
    const cagrRaw = computeCagrPct(totalRaw, PERIOD_START_DATE, TODAY);

    const dailyCost = computeEqualWeightDailyReturns(acc.dailyReturnsWithCost);
    const { totalReturnPct: totalCost, mddPct: mddCost } = computeCumulativeAndMdd(dailyCost);
    const cagrCost = computeCagrPct(totalCost, PERIOD_START_DATE, TODAY);

    console.log(`\n[${ruleType}] 거래 ${acc.trades.length}건`);
    console.log(
      `  비용 반영 전: CAGR ${cagrRaw.toFixed(1)}%, MDD ${mddRaw.toFixed(1)}%, 승률 ${(aggregateRaw.winRate * 100).toFixed(1)}%, ` +
        `평균 ${before.avgReturnPct.toFixed(2)}%, 중앙값 ${before.medianReturnPct.toFixed(2)}%, ` +
        `손익비 ${before.payoffRatio !== null ? before.payoffRatio.toFixed(2) : "-"}:1`
    );
    console.log(
      `  비용 반영 후: CAGR ${cagrCost.toFixed(1)}%, MDD ${mddCost.toFixed(1)}%, 승률 ${(after.winRate * 100).toFixed(1)}%, ` +
        `평균 ${after.avgReturnPct.toFixed(2)}%, 중앙값 ${after.medianReturnPct.toFixed(2)}%, ` +
        `손익비 ${after.payoffRatio !== null ? after.payoffRatio.toFixed(2) : "-"}:1`
    );
    console.log(
      `  차이: CAGR ${(cagrCost - cagrRaw).toFixed(1)}%p, MDD ${(mddCost - mddRaw).toFixed(1)}%p, ` +
        `승률 ${((after.winRate - aggregateRaw.winRate) * 100).toFixed(1)}%p`
    );
  }

  console.log("\n완료");
}

main().catch((error) => {
  console.error("거래비용 영향 진단 중 오류:", error);
  process.exit(1);
});
