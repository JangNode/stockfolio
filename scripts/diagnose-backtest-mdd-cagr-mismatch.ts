/**
 * [디스포저블 진단 스크립트] "장기 백테스트(2016~오늘)" 결과의 MDD/CAGR/승률 조합이
 * 이상해 보인다는 제보 확인용. 순수 조회+계산 — DB에 아무것도 쓰지 않는다.
 *
 * 확인할 가설:
 * 1. 소수 트레이드 의존: 상위 5~10개 "개별 트레이드"(종목이 아니라 거래 단위)를
 *    제외했을 때 CAGR이 얼마나 바뀌는지. 기존 strategy_backtest_summary의
 *    top5_exclude_return_pct는 "종목" 단위 제외라, 트레이드 단위로 다시 계산해
 *    더 정밀하게 확인한다.
 * 2. 승률-손익비 불일치: 평균 승리 트레이드 수익률/평균 패배 트레이드 수익률(손익비)이
 *    승률과 산술적으로 맞는지(승률×평균승 + (1-승률)×평균패 ≈ 평균수익률).
 *
 * 가설 2(MDD 계산이 포지션 단위로 잘못 집계됐는지)와 가설 3(구간 리셋/이어붙이기)은
 * 코드 리딩만으로 확인 가능해 이 스크립트에서는 다루지 않는다(별도 보고).
 *
 * 필요 환경변수: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   tsx --conditions=react-server scripts/diagnose-backtest-mdd-cagr-mismatch.ts
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { discoverCandidateStockCodes, getDailyPriceSeries, type StockDailyPriceRow } from "@/lib/stockDailyPricesStorage";
import { loadFundamentalsSeriesWithListedShares, type FundamentalsSeries } from "@/lib/stockFundamentals";
import { runBacktest, type StrategyRule, type DailyPrice, type MaCrossParams, type MinerviniParams } from "@/lib/backtest";
import { STOCK_DATA_CANDIDATE_MARKET_CAP_EOK } from "@/lib/stockDataConfig";
import type { ListedSharesByFiscalYear } from "@/lib/pegRatio";
import {
  STRATEGY_BACKTEST_WINDOW_START_YEAR,
  STRATEGY_BACKTEST_TARGET_RULE_TYPES,
  FALLBACK_MA_CROSS_PARAMS,
  FALLBACK_MINERVINI_PARAMS,
} from "@/lib/strategyBacktestSummaryConfig";
import { computeCagrPct, computeCumulativeAndMdd, computeEqualWeightDailyReturns } from "@/lib/strategyBacktestSummary";

const CURRENT_YEAR = new Date().getUTCFullYear();
const TODAY = new Date().toISOString().slice(0, 10);
const PERIOD_START_DATE = `${STRATEGY_BACKTEST_WINDOW_START_YEAR}-01-01`;
const PRICE_FETCH_START_DATE = "2014-01-01";

const BATCH_CONCURRENCY = 10;
const PROGRESS_LOG_INTERVAL = 100;

const TARGET_RULE_TYPES = STRATEGY_BACKTEST_TARGET_RULE_TYPES;
type TargetRuleType = (typeof TARGET_RULE_TYPES)[number];

interface TaggedTrade {
  stockCode: string;
  buyDate: string;
  sellDate: string;
  returnPct: number; // 비율 그대로(0.01=1%)
  isForcedLiquidation?: boolean;
}

interface DailyEntry {
  key: string; // `${stockCode}|${buyDate}` — 트레이드 식별자
  returnPct: number; // 비율 그대로
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

/** dailyEntries 중 excludeKeys에 해당하는 트레이드의 기여분을 뺀 뒤 동일가중 평균
 * 일별수익률(%) 시계열을 만든다. */
function buildDailySeriesExcluding(dailyEntries: Map<string, DailyEntry[]>, excludeKeys: Set<string>): number[] {
  const dates = Array.from(dailyEntries.keys()).sort();
  return dates.map((date) => {
    const entries = (dailyEntries.get(date) ?? []).filter((e) => !excludeKeys.has(e.key));
    if (entries.length === 0) return 0;
    return (entries.reduce((sum, e) => sum + e.returnPct, 0) / entries.length) * 100;
  });
}

interface RuleTypeAccumulator {
  trades: TaggedTrade[];
  dailyEntries: Map<string, DailyEntry[]>;
}

function createAccumulator(): RuleTypeAccumulator {
  return { trades: [], dailyEntries: new Map() };
}

async function main(): Promise<void> {
  console.log(`MDD/CAGR/승률 조합 진단 시작: ${new Date().toISOString()}`);

  const [maCrossActive, minerviniActive] = await Promise.all([
    loadActiveRuleParams("ma_cross"),
    loadActiveRuleParams("minervini_trend_template"),
  ]);
  const maCrossParams = (maCrossActive as unknown as MaCrossParams | null) ?? FALLBACK_MA_CROSS_PARAMS;
  const minerviniParams = (minerviniActive as unknown as MinerviniParams | null) ?? FALLBACK_MINERVINI_PARAMS;
  console.log(`ma_cross 파라미터: ${JSON.stringify(maCrossParams)}`);
  console.log(`minervini_trend_template 파라미터: ${JSON.stringify(minerviniParams)}`);

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
        for (const trade of result.trades) {
          acc.trades.push({
            stockCode,
            buyDate: trade.buyDate,
            sellDate: trade.sellDate,
            returnPct: trade.returnPct,
            isForcedLiquidation: trade.isForcedLiquidation,
          });

          const tradeKey = `${stockCode}|${trade.buyDate}`;
          const buyIdx = dateIndex.get(trade.buyDate);
          const sellIdx = dateIndex.get(trade.sellDate);
          if (buyIdx === undefined || sellIdx === undefined) continue;

          for (let i = buyIdx + 1; i <= sellIdx; i++) {
            const date = prices[i].date;
            if (date < PERIOD_START_DATE) continue;
            const dailyReturn = (prices[i].close - prices[i - 1].close) / prices[i - 1].close;

            const list = acc.dailyEntries.get(date);
            const entry: DailyEntry = { key: tradeKey, returnPct: dailyReturn };
            if (list) list.push(entry);
            else acc.dailyEntries.set(date, [entry]);
          }
        }
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

  for (const ruleType of TARGET_RULE_TYPES) {
    const acc = accumulators[ruleType];
    const totalTrades = acc.trades.length;
    if (totalTrades === 0) {
      console.log(`\n[${ruleType}] 거래 없음`);
      continue;
    }

    console.log(`\n=== ${ruleType} (거래 ${totalTrades}건) ===`);

    // --- 가설 4: 승률-손익비 일관성 ---
    const wins = acc.trades.filter((t) => t.returnPct > 0);
    const losses = acc.trades.filter((t) => t.returnPct <= 0);
    const winRate = wins.length / totalTrades;
    const avgWinPct = wins.length > 0 ? (wins.reduce((s, t) => s + t.returnPct, 0) / wins.length) * 100 : 0;
    const avgLossPct = losses.length > 0 ? (losses.reduce((s, t) => s + t.returnPct, 0) / losses.length) * 100 : 0;
    const payoffRatio = avgLossPct !== 0 ? avgWinPct / Math.abs(avgLossPct) : Infinity;
    const impliedAvg = winRate * avgWinPct + (1 - winRate) * avgLossPct;
    const actualAvg = (acc.trades.reduce((s, t) => s + t.returnPct, 0) / totalTrades) * 100;
    const actualMedian = median(acc.trades.map((t) => t.returnPct * 100));

    console.log(
      `  승률 ${(winRate * 100).toFixed(1)}% (승 ${wins.length}/패 ${losses.length}), ` +
        `평균승 ${avgWinPct.toFixed(2)}%, 평균패 ${avgLossPct.toFixed(2)}%, 손익비 ${payoffRatio.toFixed(2)}:1`
    );
    console.log(
      `  평균수익률: 실제 ${actualAvg.toFixed(2)}% vs 승률×평균승+(1-승률)×평균패 계산값 ${impliedAvg.toFixed(2)}% ` +
        `(일치해야 정상, 중앙값 ${actualMedian.toFixed(2)}%)`
    );

    // --- 가설 1: 트레이드 단위 상위 5/10개 제외 ---
    const dailySeriesAll = computeEqualWeightDailyReturns(
      new Map(Array.from(acc.dailyEntries.entries()).map(([d, es]) => [d, es.map((e) => ({ stockCode: e.key, returnPct: e.returnPct }))]))
    );
    const { totalReturnPct: totalAll, mddPct: mddAll } = computeCumulativeAndMdd(dailySeriesAll);
    const cagrAll = computeCagrPct(totalAll, PERIOD_START_DATE, TODAY);

    const sortedByReturn = [...acc.trades].sort((a, b) => b.returnPct - a.returnPct);
    const top5Keys = new Set(sortedByReturn.slice(0, 5).map((t) => `${t.stockCode}|${t.buyDate}`));
    const top10Keys = new Set(sortedByReturn.slice(0, 10).map((t) => `${t.stockCode}|${t.buyDate}`));

    const series5 = buildDailySeriesExcluding(acc.dailyEntries, top5Keys);
    const { totalReturnPct: total5, mddPct: mdd5 } = computeCumulativeAndMdd(series5);
    const cagr5 = computeCagrPct(total5, PERIOD_START_DATE, TODAY);

    const series10 = buildDailySeriesExcluding(acc.dailyEntries, top10Keys);
    const { totalReturnPct: total10, mddPct: mdd10 } = computeCumulativeAndMdd(series10);
    const cagr10 = computeCagrPct(total10, PERIOD_START_DATE, TODAY);

    console.log(`  [전체] CAGR ${cagrAll.toFixed(1)}%, MDD ${mddAll.toFixed(1)}%`);
    console.log(
      `  [상위 5개 트레이드 제외] CAGR ${cagr5.toFixed(1)}% (변화 ${(cagr5 - cagrAll).toFixed(1)}%p), MDD ${mdd5.toFixed(1)}%`
    );
    console.log(
      `  [상위 10개 트레이드 제외] CAGR ${cagr10.toFixed(1)}% (변화 ${(cagr10 - cagrAll).toFixed(1)}%p), MDD ${mdd10.toFixed(1)}%`
    );

    console.log("  상위 10개 트레이드:");
    for (const t of sortedByReturn.slice(0, 10)) {
      console.log(
        `    ${t.stockCode} ${t.buyDate}→${t.sellDate}: ${(t.returnPct * 100).toFixed(1)}%${t.isForcedLiquidation ? "(강제청산)" : ""}`
      );
    }
  }

  console.log("RESULT_TABLE_END");
  console.log("\n완료");
}

main().catch((error) => {
  console.error("진단 중 오류:", error);
  process.exit(1);
});
