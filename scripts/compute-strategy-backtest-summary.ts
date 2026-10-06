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
 * concentration.ts #358, 둘 다 정리 PR로 제거됨)로 검증된 것을
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
  DEFAULT_ON_OR_BEFORE_LOOKBACK_DAYS,
  loadAllStockSeriesFromParquet,
  type StockDailyPriceRow,
} from "@/lib/stockDailyPricesStorage";
import { computeTrailingAvgTradingValue, pickListedSharesOnOrBefore } from "@/lib/pitUniverse";
import { loadAppliedAdjustments } from "@/lib/stockPriceAdjustmentsStorage";
import { loadFundamentalsSeriesWithListedShares, type FundamentalsSeries } from "@/lib/stockFundamentals";
import {
  runBacktest,
  aggregateTrades,
  type StrategyRule,
  type DailyPrice,
  type BacktestTrade,
  type MaCrossParams,
} from "@/lib/backtest";
import type { ListedSharesByFiscalYear } from "@/lib/pegRatio";
import {
  STRATEGY_BACKTEST_WINDOW_START_YEAR,
  STRATEGY_BACKTEST_TOP_EXCLUDE_COUNT,
  STRATEGY_BACKTEST_TARGET_RULE_TYPES,
  STRATEGY_BACKTEST_DATA_WIDEN_STAGE_DEFAULT,
  STRATEGY_BACKTEST_DATA_WIDEN_STAGE_PUBLISHED,
  STRATEGY_BACKTEST_DISPLAY_STAGE,
  PIT_LIQUIDITY_LOOKBACK_DAYS,
  PIT_MIN_AVG_TRADING_VALUE_WON,
  PIT_LIQUIDITY_SENSITIVITY_WON,
  FALLBACK_MA_CROSS_PARAMS,
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
import { getIndexPriceSeries } from "@/lib/betaPriceHistoryStorage";
import {
  computeIndexDailyReturnsPct,
  simulateUniverseMonthlyRebalance,
  computeCalmarRatio,
  computeMonthlyRebalanceDates,
} from "@/lib/benchmarkSummary";

const CURRENT_YEAR = new Date().getUTCFullYear();
const TODAY = new Date().toISOString().slice(0, 10);
const DATA_WIDEN_STAGE = process.env.DATA_WIDEN_STAGE || STRATEGY_BACKTEST_DATA_WIDEN_STAGE_DEFAULT;
// true면 거래비용을 끄고 계산하되 DB에는 저장하지 않는다(전략 자체의 우위 확인용 검증 실행, 2026-10-04).
const COST_FREE_DRY_RUN = process.env.COST_FREE_DRY_RUN === "true";
const INCLUDE_COSTS = !COST_FREE_DRY_RUN;
const COST_LABEL = INCLUDE_COSTS ? "비용 반영" : "비용 미반영";
// 시총 유니버스(2026-10-06 화면 기본 결과로 승격): 0이면 사용 안 함(기본, 기존 동작). 양수면 그날(as-of) 저장된
// 시총(억)이 이 값 이상인 종목만 진입·벤치마크 편입 후보로 삼는다(유동성 5억 필터와 병행). 이때 유동성
// 민감도(1억/10억) 벤치마크는 계산하지 않는다. 결과 stage는 DATA_WIDEN_STAGE로 구분해 저장한다
// (주간 워크플로가 5000 + pit_adjusted_cap5000으로 한 번 더 실행한다).
const MIN_MARKET_CAP_EOK = Number(process.env.UNIVERSE_MIN_MARKET_CAP_EOK) || 0;
// 시총 필터를 켠 결과가 필터 없는 기본 stage에 섞여 저장되지 않게 막는다.
if (MIN_MARKET_CAP_EOK > 0 && DATA_WIDEN_STAGE === STRATEGY_BACKTEST_DATA_WIDEN_STAGE_DEFAULT) {
  throw new Error(`UNIVERSE_MIN_MARKET_CAP_EOK를 쓰려면 DATA_WIDEN_STAGE를 기본값(${STRATEGY_BACKTEST_DATA_WIDEN_STAGE_DEFAULT})과 다르게 지정해야 합니다.`);
}
const LIQUIDITY_SENSITIVITIES = MIN_MARKET_CAP_EOK > 0 ? [] : PIT_LIQUIDITY_SENSITIVITY_WON;
const capOk = (row: StockDailyPriceRow): boolean => MIN_MARKET_CAP_EOK === 0 || row.marketCapEok >= MIN_MARKET_CAP_EOK;
// 실험·검증 옵션(기본값=현재 동작): BACKTEST_WINDOW_START_YEAR를 주면 백테스트 시작 연도를
// 그 값으로 바꾼다(예: 2010 — 2010~2015 구간 검증 실행). 이때 시세 로드 시작 연도도 함께 앞당긴다.
// 화면 기본 stage나 승격 stage에 다른 기간 결과가 섞여 저장되지 않도록, 저장하는 실행(비용 반영)이면
// 별도 DATA_WIDEN_STAGE가 필수다.
const WINDOW_START_YEAR_OVERRIDE = Number(process.env.BACKTEST_WINDOW_START_YEAR) || 0;
const WINDOW_START_YEAR = WINDOW_START_YEAR_OVERRIDE || STRATEGY_BACKTEST_WINDOW_START_YEAR;
if (
  WINDOW_START_YEAR_OVERRIDE > 0 &&
  !COST_FREE_DRY_RUN &&
  [STRATEGY_BACKTEST_DATA_WIDEN_STAGE_DEFAULT, STRATEGY_BACKTEST_DATA_WIDEN_STAGE_PUBLISHED, STRATEGY_BACKTEST_DISPLAY_STAGE].includes(DATA_WIDEN_STAGE)
) {
  throw new Error("BACKTEST_WINDOW_START_YEAR를 쓰려면 DATA_WIDEN_STAGE를 기본·승격·화면 stage와 다르게 지정하거나 COST_FREE_DRY_RUN=true로 실행해야 합니다.");
}
const PERIOD_START_DATE = `${WINDOW_START_YEAR}-01-01`;
// 미너비니 250봉(신고/신저가)+20봉(추세 확인) 워밍업이 PERIOD_START_DATE에 이미
// 끝나 있도록 넉넉히 2년 전부터 가격을 받아온다(diagnose-strategy-daily-returns.ts와
// 동일 여유).
// 시세 백필 시작 연도(scripts/backfill-stock-daily-prices.ts의 BACKFILL_START_YEAR)와 같다 —
// 워밍업 + peg_lynch가 공시일 시점 상장주식수를 찾을 때 필요한 가장 이른 연도.
const PRICE_FETCH_START_YEAR = Math.min(2011, WINDOW_START_YEAR);

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

/** ma_cross는 사용자 개인화 값(rule_params)이라 상수로 고정할
 * 수 없다 — strategies 테이블(market='KR')에 등록된 첫 번째 행을 대표값으로 쓰고,
 * 없으면 lib/strategyBacktestSummaryConfig.ts의 임시 기본값을 쓴다
 * (components/StrategyManager.tsx의 "전략 성과 비교"와 동일한 "대표 전략" 관례 —
 * strategies 테이블엔 is_active 플래그가 없다). */
async function loadActiveRuleParams(ruleType: "ma_cross"): Promise<Record<string, unknown> | null> {
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
  console.log(`장기 백테스트(${WINDOW_START_YEAR}~오늘) 요약 계산 시작: ${new Date().toISOString()}`);

  const maCrossActive = await loadActiveRuleParams("ma_cross");
  const maCrossParams = (maCrossActive as unknown as MaCrossParams | null) ?? FALLBACK_MA_CROSS_PARAMS;
  console.log(
    maCrossActive
      ? `ma_cross 대표 전략 사용: ${JSON.stringify(maCrossParams)}`
      : `ma_cross 대표 전략 없음 — 기본값 사용: ${JSON.stringify(maCrossParams)}`
  );

  const RULES: Record<TargetRuleType, StrategyRule> = {
    ma_cross: { rule_type: "ma_cross", rule_params: maCrossParams },
    reversal_breakout_v2: { rule_type: "reversal_breakout_v2", rule_params: {} },
    peg_lynch: { rule_type: "peg_lynch", rule_params: {} },
  };

  // 시점별(point-in-time) 유니버스: 전종목(상장폐지 포함) 시세를 Parquet에서만 읽고(hot 표 미사용),
  // 각 날짜에 시세가 있는 종목 중 직전 20거래일 평균 거래대금이 기준 이상인 종목만 그날 진입
  // 후보로 삼는다(lib/pitUniverse.ts). 5개 전략과 벤치마크가 같은 기준을 공유한다.
  const startedMs = Date.now();
  const [kospiSeries, kosdaqSeries] = await Promise.all([
    getIndexPriceSeries("KOSPI", PERIOD_START_DATE, TODAY),
    getIndexPriceSeries("KOSDAQ", PERIOD_START_DATE, TODAY),
  ]);
  const rebalanceDates = computeMonthlyRebalanceDates(
    kospiSeries.map((p) => p.tradeDate).filter((d) => d >= PERIOD_START_DATE).sort()
  );

  // 분할·병합 조정계수(신뢰도 높은 이벤트만)를 배치 전용으로 적용해 읽는다 — 원본 Parquet와 화면용
  // 조회 함수는 원가 그대로다(lib/priceAdjustment.ts).
  const appliedAdjustments = await loadAppliedAdjustments();
  console.log(`조정계수 적용 대상: ${appliedAdjustments.size}종목`);
  const seriesByCode = await loadAllStockSeriesFromParquet(PRICE_FETCH_START_YEAR, CURRENT_YEAR, appliedAdjustments);
  const universe = Array.from(seriesByCode.keys());
  console.log(
    MIN_MARKET_CAP_EOK > 0
      ? `시총 유니버스: 그날(as-of) 저장 시총 ${MIN_MARKET_CAP_EOK}억 이상 + 유동성 ${PIT_MIN_AVG_TRADING_VALUE_WON / 1e8}억 이상, stage=${DATA_WIDEN_STAGE}, ${COST_LABEL}`
      : "시총 필터 없음(기본 유니버스: 유동성 기준만)"
  );
  console.log(
    `전체 종목(시세 존재 이력): ${universe.length}개 — 시점별 유동성(직전 ${PIT_LIQUIDITY_LOOKBACK_DAYS}거래일 평균 ` +
      `거래대금 ${PIT_MIN_AVG_TRADING_VALUE_WON / 1e8}억원 이상)으로 진입 후보를 걸러냄. ` +
      `로드 완료 ${((Date.now() - startedMs) / 1000).toFixed(0)}초, heap ${(process.memoryUsage().heapUsed / 1048576).toFixed(0)}MB`
  );
  const lowestThresholdWon = Math.min(
    PIT_MIN_AVG_TRADING_VALUE_WON,
    ...LIQUIDITY_SENSITIVITIES.map((s) => s.minAvgTradingValueWon)
  );
  // 리밸런싱 날짜별 종목의 직전 20거래일 평균 거래대금(벤치마크 유니버스 필터용).
  const liquidityAtRebalance = new Map<string, Map<string, number>>();
  let everEligibleCount = 0;

  const accumulators: Record<TargetRuleType, RuleTypeAccumulator> = {
    ma_cross: createAccumulator(),
    reversal_breakout_v2: createAccumulator(),
    peg_lynch: createAccumulator(),
  };

  // 벤치마크(유니버스 동일가중 월간 리밸런싱) 계산이 재사용할 종목별 (날짜, 종가) 시계열 —
  // 전략 계산 때문에 이미 종목마다 한 번 읽는 것이므로 벤치마크 때문에 다시 읽지 않는다. 종목
  // 수가 수천 개라 메모리를 아끼려고 종가만 보관한다.
  const pricesByStock = new Map<string, { date: string; close: number }[]>();

  let completed = 0;
  await runWithConcurrency(universe, BATCH_CONCURRENCY, async (stockCode) => {
    try {
      const priceRows = seriesByCode.get(stockCode) ?? [];
      if (priceRows.length === 0) return;

      const prices = priceRows.map(toDailyPrice);
      const avgTradingValue = computeTrailingAvgTradingValue(priceRows, PIT_LIQUIDITY_LOOKBACK_DAYS);
      const indexByDate = new Map<string, number>(prices.map((p, i) => [p.date, i]));

      const liquidity = new Map<string, number>();
      for (const d of rebalanceDates) {
        const i = indexByDate.get(d);
        if (i !== undefined && Number.isFinite(avgTradingValue[i]) && capOk(priceRows[i])) liquidity.set(d, avgTradingValue[i]);
      }
      liquidityAtRebalance.set(stockCode, liquidity);
      pricesByStock.set(
        stockCode,
        prices.map((p) => ({ date: p.date, close: p.close }))
      );

      // 기간 내 한 번이라도(가장 낮은 민감도 기준) 유동성 조건을 넘긴 적 없는 종목은 전략 계산을
      // 건너뛴다(어차피 진입 불가) — 벤치마크용 시세/유동성은 위에서 이미 보관했다.
      let everEligible = false;
      for (let i = 0; i < prices.length; i++) {
        if (prices[i].date >= PERIOD_START_DATE && avgTradingValue[i] >= lowestThresholdWon && capOk(priceRows[i])) {
          everEligible = true;
          break;
        }
      }
      if (!everEligible) return;
      let everEligibleMain = false;
      for (let i = 0; i < prices.length; i++) {
        if (prices[i].date >= PERIOD_START_DATE && avgTradingValue[i] >= PIT_MIN_AVG_TRADING_VALUE_WON && capOk(priceRows[i])) {
          everEligibleMain = true;
          break;
        }
      }
      if (everEligibleMain) everEligibleCount++;
      const entryAllowed = (date: string): boolean => {
        const i = indexByDate.get(date);
        return i !== undefined && avgTradingValue[i] >= PIT_MIN_AVG_TRADING_VALUE_WON && capOk(priceRows[i]);
      };

      let fundamentals: FundamentalsSeries | undefined;
      let listedSharesByFiscalYear: ListedSharesByFiscalYear | undefined;
      try {
        const loaded = await loadFundamentalsSeriesWithListedShares(stockCode, (_code, date) =>
          pickListedSharesOnOrBefore(priceRows, date, DEFAULT_ON_OR_BEFORE_LOOKBACK_DAYS)
        );
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
          needsFundamentals ? listedSharesByFiscalYear : undefined,
          { market: "KR", entryAllowed, includeTransactionCosts: INCLUDE_COSTS }
        );
        if (result.insufficientData || result.trades.length === 0) continue;

        const acc = accumulators[ruleType];
        acc.trades.push(...result.trades);
        accumulateStockDailyReturns(
          acc.dailyReturns,
          acc.contributions,
          stockCode,
          prices,
          result.trades,
          PERIOD_START_DATE,
          "KR",
          INCLUDE_COSTS
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  ${stockCode} 처리 실패, 건너뜁니다: ${message}`);
    } finally {
      seriesByCode.delete(stockCode); // 처리 끝난 종목의 원본 행은 바로 해제(메모리 상한 관리)
      completed++;
      if (completed === 1 || completed % PROGRESS_LOG_INTERVAL === 0 || completed === universe.length) {
        console.log(`  [${completed}/${universe.length}] 종목 처리 중...`);
      }
    }
  });

  // 월별(리밸런싱 시점) 편입 종목 수 = 그날 시세가 있고 유동성 조건을 넘는 종목 수.
  for (const thresholdWon of [PIT_MIN_AVG_TRADING_VALUE_WON, ...LIQUIDITY_SENSITIVITIES.map((s) => s.minAvgTradingValueWon)]) {
    const counts = rebalanceDates.map((d) => {
      let n = 0;
      for (const liquidity of liquidityAtRebalance.values()) {
        const v = liquidity.get(d);
        if (v !== undefined && v >= thresholdWon) n++;
      }
      return n;
    });
    const avg = counts.reduce((sum, v) => sum + v, 0) / Math.max(counts.length, 1);
    console.log(
      `월별 편입 종목 수(유동성 ${thresholdWon / 1e8}억원, ${counts.length}개 리밸런싱 시점): ` +
        `최소 ${Math.min(...counts)} / 평균 ${avg.toFixed(0)} / 최대 ${Math.max(...counts)}`
    );
  }

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

    // 손익비(평균승/평균패) — "장기 백테스트" 카드에서 MDD가 높은데 CAGR이
    // 플러스인 조합이 트렌드추종 손익 구조(손절 짧고 승리 큼)인지 소수 트레이드
    // 의존인지 구분하는 데 쓴다(2026-09-29 진단으로 검증된 계산 그대로 승격).
    // 승/패 중 한쪽이 0건이거나 평균패가 0이면 계산 불가라 null로 둔다(0으로
    // 나누기·NaN이 DB에 들어가지 않게).
    const winReturns = returnPctList.filter((v) => v > 0);
    const lossReturns = returnPctList.filter((v) => v <= 0);
    const avgWinPct = winReturns.length > 0 ? winReturns.reduce((s, v) => s + v, 0) / winReturns.length : null;
    const avgLossPct = lossReturns.length > 0 ? lossReturns.reduce((s, v) => s + v, 0) / lossReturns.length : null;
    const payoffRatio = avgWinPct !== null && avgLossPct !== null && avgLossPct !== 0 ? avgWinPct / Math.abs(avgLossPct) : null;

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

    const { error } = COST_FREE_DRY_RUN ? { error: null } : await supabaseAdmin.from("strategy_backtest_summary").insert({
      rule_type: ruleType,
      market: "KR",
      period_start_date: PERIOD_START_DATE,
      period_end_date: TODAY,
      universe_stock_count: everEligibleCount,
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
      avg_win_pct: avgWinPct,
      avg_loss_pct: avgLossPct,
      payoff_ratio: payoffRatio,
      cost_included: true,
      data_widen_stage: DATA_WIDEN_STAGE,
    });

    if (error) {
      console.error(`  [${ruleType}] 저장 실패: ${error.message}`);
      continue;
    }

    console.log(
      `  [${ruleType}] 거래 ${totalTrades}건(종료 ${closedTrades}/강제청산 ${aggregate.forcedLiquidationCount}), ` +
        `승률 ${(aggregate.winRate * 100).toFixed(1)}%, 평균 ${avgReturnPct.toFixed(1)}%, 중앙값 ${medianReturnPct.toFixed(1)}%, ` +
        `MDD ${mddPct.toFixed(1)}%, CAGR ${cagrPct.toFixed(1)}%, 상위5제외 CAGR ${top5ExcludeCagrPct.toFixed(1)}%, ` +
        `손익비 ${payoffRatio !== null ? `${payoffRatio.toFixed(2)}:1` : "-"} (${COST_LABEL}) — ${COST_FREE_DRY_RUN ? "저장 안 함" : "저장 완료"}`
    );
  }

  console.log("\n=== 벤치마크(코스피/코스닥/유니버스 월간 리밸런싱) 계산 및 저장 ===");

  const eligibleAtRebalance = (thresholdWon: number) => (stockCode: string, date: string) =>
    (liquidityAtRebalance.get(stockCode)?.get(date) ?? NaN) >= thresholdWon;
  const universeCalendar = kospiSeries.map((p) => p.tradeDate);

  const benchmarkInputs: { benchmarkType: string; dailyReturnsPct: number[]; costIncluded: boolean }[] = [
    { benchmarkType: "kospi", dailyReturnsPct: computeIndexDailyReturnsPct(kospiSeries), costIncluded: false },
    { benchmarkType: "kosdaq", dailyReturnsPct: computeIndexDailyReturnsPct(kosdaqSeries), costIncluded: false },
    {
      benchmarkType: "universe_monthly_rebalance",
      // 코스피 지수 시리즈의 tradeDate를 실제 KRX 거래일 캘린더로 재사용한다
      // (따로 캘린더를 조회하지 않는다).
      dailyReturnsPct: simulateUniverseMonthlyRebalance(
        pricesByStock,
        universeCalendar,
        PERIOD_START_DATE,
        eligibleAtRebalance(PIT_MIN_AVG_TRADING_VALUE_WON),
        INCLUDE_COSTS
      ),
      costIncluded: INCLUDE_COSTS,
    },
    // 유동성 기준 민감도(1억/10억) — 벤치마크에서만 계산한다.
    ...LIQUIDITY_SENSITIVITIES.map(({ label, minAvgTradingValueWon }) => ({
      benchmarkType: `universe_monthly_rebalance_${label}`,
      dailyReturnsPct: simulateUniverseMonthlyRebalance(
        pricesByStock,
        universeCalendar,
        PERIOD_START_DATE,
        eligibleAtRebalance(minAvgTradingValueWon),
        INCLUDE_COSTS
      ),
      costIncluded: INCLUDE_COSTS,
    })),
  ];

  const benchmarkRows = benchmarkInputs.map(({ benchmarkType, dailyReturnsPct, costIncluded }) => {
    const { totalReturnPct, mddPct } = computeCumulativeAndMdd(dailyReturnsPct);
    const cagrPct = computeCagrPct(totalReturnPct, PERIOD_START_DATE, TODAY);
    const calmarRatio = computeCalmarRatio(cagrPct, mddPct);
    return { benchmarkType, cagrPct, mddPct, calmarRatio, costIncluded };
  });

  for (const row of benchmarkRows) {
    const { error } = COST_FREE_DRY_RUN ? { error: null } : await supabaseAdmin.from("benchmark_summary").insert({
      benchmark_type: row.benchmarkType,
      period_start_date: PERIOD_START_DATE,
      period_end_date: TODAY,
      cagr_pct: row.cagrPct,
      mdd_pct: row.mddPct,
      calmar_ratio: row.calmarRatio,
      cost_included: row.costIncluded,
      data_widen_stage: DATA_WIDEN_STAGE,
    });

    if (error) {
      console.error(`  [${row.benchmarkType}] 벤치마크 저장 실패: ${error.message}`);
      continue;
    }

    console.log(
      `  [${row.benchmarkType}] MDD ${row.mddPct.toFixed(1)}%, CAGR ${row.cagrPct.toFixed(1)}%, ` +
        `칼마 ${row.calmarRatio.toFixed(2)}${row.costIncluded ? ` (${COST_LABEL})` : ""} — ${COST_FREE_DRY_RUN ? "저장 안 함" : "저장 완료"}`
    );
  }

  const usage = process.resourceUsage();
  console.log(
    `\n실행 시간 ${((Date.now() - startedMs) / 1000).toFixed(0)}초(시작 후 데이터 로드 포함), ` +
      `최대 메모리(RSS) ${(usage.maxRSS / 1024).toFixed(0)}MB`
  );
  console.log("\n완료");
}

main().catch((error) => {
  console.error("장기 백테스트 요약 계산 중 오류:", error);
  process.exit(1);
});
