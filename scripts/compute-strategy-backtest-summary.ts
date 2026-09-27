/**
 * "전략 관리" 탭의 "장기 백테스트(2016~오늘)" 섹션이 읽는 캐시를 매주 한 번
 * 재계산하는 배치. 생존편향 보정된 KR 전용 다년치 시세 Storage
 * (lib/stockDailyPricesStorage.ts)로 2016년부터 오늘까지 전종목을 대상으로
 * runBacktest를 직접 호출해 rule_type별로 하나씩 요약 행을 strategy_backtest_summary
 * 테이블에 insert한다(매번 새로 insert하는 이력 테이블 — 덮어쓰기 아님).
 *
 * US 시장은 생존편향 보정된 다년치 시세 Storage가 없어 이번엔 계산 대상에서
 * 뺀다(2026-09-27 계획 승인). custom_composite도 사용자마다 조건이 다른 실험
 * 전략이라 "대표 전략" 개념이 성립하지 않아 제외한다.
 *
 * 계산 로직(날짜별 동일가중 평균/MDD/CAGR/상위종목 제외)은 이미 디스포저블 진단
 * 스크립트(diagnose-strategy-daily-returns.ts #356, diagnose-strategy-return-
 * concentration.ts #358, 둘 다 정리 PR로 제거될 예정)로 검증된 것을
 * lib/strategyBacktestSummary.ts로 승격시켜 그대로 재사용한다.
 *
 * server-only로 막힌 lib/supabaseAdmin.ts를 순수 Node 스크립트에서도 쓰기 위해
 * "react-server" 조건으로 실행해야 한다:
 *   tsx --conditions=react-server scripts/compute-strategy-backtest-summary.ts
 * (package.json의 batch:strategy-backtest-summary 스크립트가 이 플래그를 포함한다.)
 *
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
  STRATEGY_BACKTEST_TOP_EXCLUDE_COUNT,
  STRATEGY_BACKTEST_TARGET_RULE_TYPES,
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
// 미너비니 250봉(신고/신저가)+20봉(추세 확인) 워밍업이 PERIOD_START_DATE에 이미
// 끝나 있도록 넉넉히 2년 전부터 가격을 받아온다(diagnose-strategy-daily-returns.ts와
// 동일 여유).
const PRICE_FETCH_START_DATE = "2014-01-01";

const BATCH_CONCURRENCY = 10;
const PROGRESS_LOG_INTERVAL = 100;

const TARGET_RULE_TYPES = STRATEGY_BACKTEST_TARGET_RULE_TYPES;
type TargetRuleType = (typeof TARGET_RULE_TYPES)[number];

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

/** ma_cross/minervini_trend_template은 사용자 개인화 값(rule_params)이라 상수로 고정할
 * 수 없다 — strategies 테이블(market='KR')에 등록된 첫 번째 행을 대표값으로 쓰고,
 * 없으면 lib/strategyBacktestSummaryConfig.ts의 임시 기본값을 쓴다
 * (components/StrategyManager.tsx의 "전략 성과 비교"와 동일한 "대표 전략" 관례 —
 * strategies 테이블엔 is_active 플래그가 없다). */
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

interface RuleTypeAccumulator {
  trades: BacktestTrade[];
  dailyReturns: DailyStockReturns;
  contributions: Map<string, StockContribution>;
}

function createAccumulator(): RuleTypeAccumulator {
  return { trades: [], dailyReturns: new Map(), contributions: new Map() };
}

async function main(): Promise<void> {
  console.log(`장기 백테스트(2016~오늘) 요약 계산 시작: ${new Date().toISOString()}`);

  const [maCrossActive, minerviniActive] = await Promise.all([
    loadActiveRuleParams("ma_cross"),
    loadActiveRuleParams("minervini_trend_template"),
  ]);
  const maCrossParams = (maCrossActive as unknown as MaCrossParams | null) ?? FALLBACK_MA_CROSS_PARAMS;
  const minerviniParams = (minerviniActive as unknown as MinerviniParams | null) ?? FALLBACK_MINERVINI_PARAMS;
  console.log(
    maCrossActive
      ? `ma_cross 대표 전략 사용: ${JSON.stringify(maCrossParams)}`
      : `ma_cross 대표 전략 없음 — 기본값 사용: ${JSON.stringify(maCrossParams)}`
  );
  console.log(
    minerviniActive
      ? `minervini_trend_template 대표 전략 사용: ${JSON.stringify(minerviniParams)}`
      : `minervini_trend_template 대표 전략 없음 — 기본값 사용: ${JSON.stringify(minerviniParams)}`
  );

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
  console.log(`유니버스: ${universe.length}개 종목 (${STRATEGY_BACKTEST_WINDOW_START_YEAR}~ 시가총액 1조원 이상 이력)`);

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
      } catch (error) {
        // peg_lynch만 영향(재무 조회 실패 시 그 종목은 peg_lynch 판정에서만 제외).
        const message = error instanceof Error ? error.message : String(error);
        console.error(`    ${stockCode} 재무 조회 실패(peg_lynch만 영향): ${message}`);
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
        accumulateStockDailyReturns(acc.dailyReturns, acc.contributions, stockCode, prices, result.trades, PERIOD_START_DATE);
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

  console.log("\n=== rule_type별 요약 계산 및 저장 ===");
  for (const ruleType of TARGET_RULE_TYPES) {
    const acc = accumulators[ruleType];
    const totalTrades = acc.trades.length;

    if (totalTrades === 0) {
      console.log(`  [${ruleType}] 거래 없음 — 저장 건너뜀`);
      continue;
    }

    const aggregate = aggregateTrades(acc.trades);
    const closedTrades = totalTrades - aggregate.forcedLiquidationCount;
    const forcedLiquidationRatio = aggregate.forcedLiquidationCount / totalTrades;

    const returnPctList = acc.trades.map((t) => t.returnPct * 100);
    const avgReturnPct = returnPctList.reduce((s, v) => s + v, 0) / returnPctList.length;
    const medianReturnPct = median(returnPctList);

    const dailySeries = computeEqualWeightDailyReturns(acc.dailyReturns);
    const { totalReturnPct, mddPct } = computeCumulativeAndMdd(dailySeries);
    const cagrPct = computeCagrPct(totalReturnPct, PERIOD_START_DATE, TODAY);

    // top5_exclude_return_pct는 cagr_pct와 같은 스케일(연환산)로 저장한다 — 그래야
    // "상위 5개 제외 시 연환산 수익률이 얼마나 바뀌는지"를 UI에서 바로 비교할 수
    // 있다. computeTop5ExcludeReturnPct 자체는 연환산 전 총수익률을 반환하므로
    // 여기서 computeCagrPct를 한 번 더 적용한다.
    const top5ExcludeRawReturnPct = computeTop5ExcludeReturnPct(
      acc.dailyReturns,
      acc.contributions,
      STRATEGY_BACKTEST_TOP_EXCLUDE_COUNT
    );
    const top5ExcludeCagrPct = computeCagrPct(top5ExcludeRawReturnPct, PERIOD_START_DATE, TODAY);

    const { error } = await supabaseAdmin.from("strategy_backtest_summary").insert({
      rule_type: ruleType,
      market: "KR",
      period_start_date: PERIOD_START_DATE,
      period_end_date: TODAY,
      universe_stock_count: universe.length,
      win_rate: aggregate.winRate,
      avg_return_pct: avgReturnPct,
      median_return_pct: medianReturnPct,
      mdd_pct: mddPct,
      cagr_pct: cagrPct,
      total_trades: totalTrades,
      closed_trades: closedTrades,
      forced_liquidation_count: aggregate.forcedLiquidationCount,
      forced_liquidation_ratio: forcedLiquidationRatio,
      top5_exclude_return_pct: top5ExcludeCagrPct,
    });

    if (error) {
      console.error(`  [${ruleType}] 저장 실패: ${error.message}`);
      continue;
    }

    console.log(
      `  [${ruleType}] 거래 ${totalTrades}건(종료 ${closedTrades}/강제청산 ${aggregate.forcedLiquidationCount}), ` +
        `승률 ${(aggregate.winRate * 100).toFixed(1)}%, 평균 ${avgReturnPct.toFixed(1)}%, 중앙값 ${medianReturnPct.toFixed(1)}%, ` +
        `MDD ${mddPct.toFixed(1)}%, CAGR ${cagrPct.toFixed(1)}%, 상위5제외 CAGR ${top5ExcludeCagrPct.toFixed(1)}% — 저장 완료`
    );
  }

  console.log("\n완료");
}

main().catch((error) => {
  console.error("장기 백테스트 요약 계산 중 오류:", error);
  process.exit(1);
});
