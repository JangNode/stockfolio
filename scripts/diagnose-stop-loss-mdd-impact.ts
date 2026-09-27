/**
 * 사용자 요청(2026-09-27, 코드 변경 없이 분석만): ma_cross/minervini_trend_template/
 * peg_lynch는 현재 runBacktest에서 상태 전환(데드크로스/조건 이탈/PEG>1.0)으로만
 * 청산되고 stop_loss_pct는 시뮬레이션에 전혀 반영되지 않는다. 손절선을 5/10/15/20%로
 * 걸었을 때(기존 청산조건은 그대로 두고, 손절선이 먼저 걸리면 그걸로 청산) MDD/CAGR/
 * 승률/중앙값수익률이 어떻게 바뀌는지 확인한다. 과최적화 방지 기준은 급등주 손절/익절
 * 튜닝 때(scripts 히스토리의 analyze-reversal-breakout-stoploss-range.ts, #249)와 동일하게
 * 2016-2018/2019-2022/2023-2026 세 구간으로 나눠 일관된 개선인지 확인한다.
 *
 * 손절 오버레이 방법: runBacktest로 baseline(손절 없음) 거래를 먼저 뽑고, 각 거래의
 * buyDate 다음 거래일부터 원래 매도일까지 저가(low)가 buyPrice*(1-stopPct) 이하로
 * 떨어지는 첫 날을 찾아 그날로 조기 청산 처리한다(장중 손절이라 종가가 아니라 저가로
 * 판정 — analyze-reversal-breakout-stoploss-range.ts와 동일 관례). 못 찾으면 원래
 * 거래(자연 청산 또는 기간 끝 강제청산)를 그대로 둔다. MDD/CAGR은 이미 검증된
 * lib/strategyBacktestSummary.ts의 날짜별 동일가중 방법론을 그대로 재사용한다(장기
 * 백테스트 화면과 동일 스케일이라 서로 비교 가능).
 *
 * reversal_breakout은 손절선 테스트 대상이 아니라(구조적 쏠림 문제라 손절로 해결 안 됨을
 * 확인하는 게 목적), 상위 3개 종목 제외 시 부호가 뒤집히는지만 추가로 확인한다(기존
 * 5개 제외 결과 — cagr 26.9% → 상위5제외 -3.1% — 와 비교).
 *
 * screening_results/전략 관리 DB에는 아무것도 쓰지 않는다(순수 분석, DB insert 없음).
 * 결과 확인 후 이 스크립트/워크플로는 삭제 예정.
 *
 * 필요 환경변수: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   tsx --conditions=react-server scripts/diagnose-stop-loss-mdd-impact.ts
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { discoverCandidateStockCodes, getDailyPriceSeries, type StockDailyPriceRow } from "@/lib/stockDailyPricesStorage";
import { loadFundamentalsSeriesWithListedShares, type FundamentalsSeries } from "@/lib/stockFundamentals";
import { runBacktest, type StrategyRule, type DailyPrice, type BacktestTrade, type MaCrossParams, type MinerviniParams } from "@/lib/backtest";
import { STOCK_DATA_CANDIDATE_MARKET_CAP_EOK } from "@/lib/stockDataConfig";
import type { ListedSharesByFiscalYear } from "@/lib/pegRatio";
import {
  STRATEGY_BACKTEST_WINDOW_START_YEAR,
  FALLBACK_MA_CROSS_PARAMS,
  FALLBACK_MINERVINI_PARAMS,
} from "@/lib/strategyBacktestSummaryConfig";
import {
  accumulateStockDailyReturns,
  computeEqualWeightDailyReturns,
  computeCumulativeAndMdd,
  computeCagrPct,
  computeTop5ExcludeReturnPct,
  type DailyStockReturns,
  type StockContribution,
} from "@/lib/strategyBacktestSummary";

const CURRENT_YEAR = new Date().getUTCFullYear();
const TODAY = new Date().toISOString().slice(0, 10);
const PERIOD_START_DATE = `${STRATEGY_BACKTEST_WINDOW_START_YEAR}-01-01`;
const PRICE_FETCH_START_DATE = "2014-01-01";

const BATCH_CONCURRENCY = 10;
const PROGRESS_LOG_INTERVAL = 100;

// null = baseline(손절 없음, 기존 청산조건 그대로).
const STOP_LOSS_VARIANTS: { key: string; pct: number | null }[] = [
  { key: "baseline", pct: null },
  { key: "sl5", pct: 0.05 },
  { key: "sl10", pct: 0.1 },
  { key: "sl15", pct: 0.15 },
  { key: "sl20", pct: 0.2 },
];

const STOP_LOSS_TARGET_RULE_TYPES = ["ma_cross", "minervini_trend_template", "peg_lynch"] as const;
type StopLossTargetRuleType = (typeof STOP_LOSS_TARGET_RULE_TYPES)[number];

const PERIODS: { label: string; start: string; end: string }[] = [
  { label: "2016-2018", start: "2016-01-01", end: "2018-12-31" },
  { label: "2019-2022", start: "2019-01-01", end: "2022-12-31" },
  { label: "2023-2026", start: "2023-01-01", end: "2026-12-31" },
];

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

async function loadActiveRuleParams(ruleType: "ma_cross" | "minervini_trend_template"): Promise<Record<string, unknown> | null> {
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
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** buyDate 다음 거래일부터 원래 sellDate까지 저가가 손절가 이하로 떨어지는 첫 날을
 * 찾아 그날 손절가로 조기 청산한 거래를 반환한다. 못 찾으면 원래 거래를 그대로 반환 —
 * 이러면 자연 청산/강제청산 여부(isForcedLiquidation)도 그대로 보존된다. */
function applyStopLoss(
  trade: BacktestTrade,
  prices: DailyPrice[],
  dateIndex: Map<string, number>,
  stopLossPct: number
): BacktestTrade {
  const buyIdx = dateIndex.get(trade.buyDate);
  const sellIdx = dateIndex.get(trade.sellDate);
  if (buyIdx === undefined || sellIdx === undefined) return trade;

  const stopPrice = trade.buyPrice * (1 - stopLossPct);
  for (let i = buyIdx + 1; i <= sellIdx; i++) {
    if (prices[i].low <= stopPrice) {
      return {
        buyDate: trade.buyDate,
        buyPrice: trade.buyPrice,
        sellDate: prices[i].date,
        sellPrice: stopPrice,
        returnPct: -stopLossPct,
      };
    }
  }
  return trade;
}

function sliceDailyReturns(dailyReturns: DailyStockReturns, startDate: string, endDate: string): DailyStockReturns {
  const sliced: DailyStockReturns = new Map();
  for (const [date, entries] of dailyReturns) {
    if (date >= startDate && date <= endDate) sliced.set(date, entries);
  }
  return sliced;
}

function tradesInPeriod(trades: BacktestTrade[], start: string, end: string): BacktestTrade[] {
  return trades.filter((t) => t.buyDate >= start && t.buyDate <= end);
}

interface BucketStats {
  tradeCount: number;
  winRate: number;
  medianReturnPct: number;
  mddPct: number;
  cagrPct: number;
}

function computeBucketStats(
  trades: BacktestTrade[],
  dailyReturns: DailyStockReturns,
  periodStart: string,
  periodEnd: string
): BucketStats | null {
  if (trades.length === 0) return null;
  const wins = trades.filter((t) => t.returnPct > 0).length;
  const winRate = wins / trades.length;
  const medianReturnPct = median(trades.map((t) => t.returnPct * 100));
  const dailySeries = computeEqualWeightDailyReturns(dailyReturns);
  const { totalReturnPct, mddPct } = computeCumulativeAndMdd(dailySeries);
  const cagrPct = computeCagrPct(totalReturnPct, periodStart, periodEnd);
  return { tradeCount: trades.length, winRate, medianReturnPct, mddPct, cagrPct };
}

interface VariantAccumulator {
  trades: BacktestTrade[];
  dailyReturns: DailyStockReturns;
  contributions: Map<string, StockContribution>;
  stopTriggeredCount: number;
}

function createAccumulator(): VariantAccumulator {
  return { trades: [], dailyReturns: new Map(), contributions: new Map(), stopTriggeredCount: 0 };
}

async function main(): Promise<void> {
  console.log(`손절선 MDD/CAGR 영향 분석 시작: ${new Date().toISOString()}`);

  const [maCrossActive, minerviniActive] = await Promise.all([
    loadActiveRuleParams("ma_cross"),
    loadActiveRuleParams("minervini_trend_template"),
  ]);
  const maCrossParams = (maCrossActive as unknown as MaCrossParams | null) ?? FALLBACK_MA_CROSS_PARAMS;
  const minerviniParams = (minerviniActive as unknown as MinerviniParams | null) ?? FALLBACK_MINERVINI_PARAMS;
  console.log(`ma_cross 파라미터: ${JSON.stringify(maCrossParams)}`);
  console.log(`minervini_trend_template 파라미터: ${JSON.stringify(minerviniParams)}`);

  const RULES: Record<StopLossTargetRuleType, StrategyRule> = {
    ma_cross: { rule_type: "ma_cross", rule_params: maCrossParams },
    minervini_trend_template: { rule_type: "minervini_trend_template", rule_params: minerviniParams },
    peg_lynch: { rule_type: "peg_lynch", rule_params: {} },
  };
  const REVERSAL_BREAKOUT_RULE: StrategyRule = { rule_type: "reversal_breakout", rule_params: {} };

  const discoveryYears = Array.from(
    { length: CURRENT_YEAR - STRATEGY_BACKTEST_WINDOW_START_YEAR + 1 },
    (_, i) => STRATEGY_BACKTEST_WINDOW_START_YEAR + i
  );
  const universe = await discoverCandidateStockCodes(discoveryYears, STOCK_DATA_CANDIDATE_MARKET_CAP_EOK);
  console.log(`유니버스: ${universe.length}개 종목`);

  const accumulators: Record<StopLossTargetRuleType, Record<string, VariantAccumulator>> = {
    ma_cross: Object.fromEntries(STOP_LOSS_VARIANTS.map((v) => [v.key, createAccumulator()])),
    minervini_trend_template: Object.fromEntries(STOP_LOSS_VARIANTS.map((v) => [v.key, createAccumulator()])),
    peg_lynch: Object.fromEntries(STOP_LOSS_VARIANTS.map((v) => [v.key, createAccumulator()])),
  };
  const reversalAcc = createAccumulator();

  let completed = 0;
  await runWithConcurrency(universe, BATCH_CONCURRENCY, async (stockCode) => {
    try {
      const priceRows = await getDailyPriceSeries(stockCode, PRICE_FETCH_START_DATE, TODAY);
      if (priceRows.length === 0) return;
      const prices = priceRows.map(toDailyPrice);
      const dateIndex = new Map(prices.map((p, i) => [p.date, i]));

      let fundamentals: FundamentalsSeries | undefined;
      let listedSharesByFiscalYear: ListedSharesByFiscalYear | undefined;
      try {
        const loaded = await loadFundamentalsSeriesWithListedShares(stockCode);
        fundamentals = loaded.series;
        listedSharesByFiscalYear = loaded.listedSharesByFiscalYear;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`    ${stockCode} 재무 조회 실패(peg_lynch만 영향): ${message}`);
      }

      for (const ruleType of STOP_LOSS_TARGET_RULE_TYPES) {
        const needsFundamentals = ruleType === "peg_lynch";
        if (needsFundamentals && !fundamentals) continue;

        const baseline = runBacktest(
          prices,
          RULES[ruleType],
          PERIOD_START_DATE,
          needsFundamentals ? fundamentals : undefined,
          needsFundamentals ? listedSharesByFiscalYear : undefined
        );
        if (baseline.insufficientData || baseline.trades.length === 0) continue;

        for (const variant of STOP_LOSS_VARIANTS) {
          const acc = accumulators[ruleType][variant.key];
          const variantTrades =
            variant.pct === null
              ? baseline.trades
              : baseline.trades.map((t) => applyStopLoss(t, prices, dateIndex, variant.pct!));

          if (variant.pct !== null) {
            for (let i = 0; i < variantTrades.length; i++) {
              if (variantTrades[i].sellDate !== baseline.trades[i].sellDate) acc.stopTriggeredCount++;
            }
          }

          acc.trades.push(...variantTrades);
          accumulateStockDailyReturns(acc.dailyReturns, acc.contributions, stockCode, prices, variantTrades, PERIOD_START_DATE);
        }
      }

      const reversalResult = runBacktest(prices, REVERSAL_BREAKOUT_RULE, PERIOD_START_DATE);
      if (!reversalResult.insufficientData && reversalResult.trades.length > 0) {
        reversalAcc.trades.push(...reversalResult.trades);
        accumulateStockDailyReturns(
          reversalAcc.dailyReturns,
          reversalAcc.contributions,
          stockCode,
          prices,
          reversalResult.trades,
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

  console.log("\nRESULT_TABLE_START");

  for (const ruleType of STOP_LOSS_TARGET_RULE_TYPES) {
    console.log(`\n=== ${ruleType} ===`);
    for (const variant of STOP_LOSS_VARIANTS) {
      const acc = accumulators[ruleType][variant.key];
      if (acc.trades.length === 0) {
        console.log(`  [${variant.key}] 거래 없음`);
        continue;
      }

      const overall = computeBucketStats(acc.trades, acc.dailyReturns, PERIOD_START_DATE, TODAY);
      const triggerRate = variant.pct === null ? null : acc.stopTriggeredCount / acc.trades.length;
      const label = variant.pct === null ? "baseline(손절없음)" : `손절${(variant.pct * 100).toFixed(0)}%`;
      console.log(
        `  [${label}] overall n=${overall?.tradeCount} 승률=${((overall?.winRate ?? 0) * 100).toFixed(1)}% ` +
          `중앙값=${overall?.medianReturnPct.toFixed(2)}% MDD=${overall?.mddPct.toFixed(1)}% CAGR=${overall?.cagrPct.toFixed(1)}%` +
          (triggerRate !== null ? ` (손절발동률 ${(triggerRate * 100).toFixed(1)}%)` : "")
      );

      for (const period of PERIODS) {
        const clampedEnd = period.end > TODAY ? TODAY : period.end;
        const periodTrades = tradesInPeriod(acc.trades, period.start, clampedEnd);
        const periodDaily = sliceDailyReturns(acc.dailyReturns, period.start, clampedEnd);
        const stats = computeBucketStats(periodTrades, periodDaily, period.start, clampedEnd);
        if (!stats) {
          console.log(`    ${period.label}: 거래 없음`);
          continue;
        }
        console.log(
          `    ${period.label}: n=${stats.tradeCount} 승률=${(stats.winRate * 100).toFixed(1)}% ` +
            `중앙값=${stats.medianReturnPct.toFixed(2)}% MDD=${stats.mddPct.toFixed(1)}% CAGR=${stats.cagrPct.toFixed(1)}%`
        );
      }
    }
  }

  console.log("\n=== reversal_breakout: 상위 3개/5개 종목 제외 비교 ===");
  if (reversalAcc.trades.length > 0) {
    const overall = computeBucketStats(reversalAcc.trades, reversalAcc.dailyReturns, PERIOD_START_DATE, TODAY);
    const top3ExcludeRaw = computeTop5ExcludeReturnPct(reversalAcc.dailyReturns, reversalAcc.contributions, 3);
    const top5ExcludeRaw = computeTop5ExcludeReturnPct(reversalAcc.dailyReturns, reversalAcc.contributions, 5);
    const top3ExcludeCagr = computeCagrPct(top3ExcludeRaw, PERIOD_START_DATE, TODAY);
    const top5ExcludeCagr = computeCagrPct(top5ExcludeRaw, PERIOD_START_DATE, TODAY);
    console.log(
      `  전체 n=${overall?.tradeCount} CAGR=${overall?.cagrPct.toFixed(1)}%, ` +
        `상위3제외 CAGR=${top3ExcludeCagr.toFixed(1)}%, 상위5제외 CAGR=${top5ExcludeCagr.toFixed(1)}%`
    );
  } else {
    console.log("  거래 없음");
  }

  console.log("RESULT_TABLE_END");
  console.log("\n완료");
}

main().catch((error) => {
  console.error("분석 스크립트 실행 중 오류:", error);
  process.exit(1);
});
