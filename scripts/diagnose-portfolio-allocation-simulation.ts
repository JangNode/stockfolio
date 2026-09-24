/**
 * [디스포저블 진단 스크립트] 포트폴리오 MDD 분석 — minervini_trend_template +
 * peg_lynch 2자산 조합을 비중별로 결합 시뮬레이션하고, reversal_breakout을 소액
 * 위성 슬롯으로 얹었을 때 CAGR/MDD가 어떻게 바뀌는지 확인한다. ma_cross는 이번
 * 포트폴리오 설계에서 제외(minervini와 구조적으로 거의 같은 신호로 확인됨,
 * diagnose-strategy-return-concentration.ts 결과 참고) — 코드는 lib/backtest.ts에
 * 그대로 남아있으니 나중에 필요하면 다시 쓸 수 있다.
 *
 * 유니버스/기간은 diagnose-strategy-daily-returns.ts와 동일(2016~오늘, 시가총액
 * 1조원 이상 이력). DB/Storage 쓰기 없음(순수 조회+계산).
 *
 * 1. minervini/peg_lynch 각각의 종목 쏠림도 재확인(상위 8개 제외 후 재계산) —
 *    reversal_breakout처럼 심한지 확인 없이 넘어가지 않는다.
 * 2. minervini:peg_lynch = 50:50/70:30/30:70/60:40(임시 핵심안) 비중별 결합
 *    포트폴리오의 누적수익률/CAGR/MDD/샤프비율(무위험수익률 0 가정) 계산.
 * 3. 60:40 핵심안에 reversal_breakout을 5%/10% 위성 비중으로 얹는다(핵심 비중은
 *    100%에서 위성 비중을 뺀 만큼 그대로 축소 — 예: 5% 추가 시 minervini 57%/
 *    peg_lynch 38%/reversal_breakout 5%). reversal_breakout 상위 기여 종목들의
 *    실제 매수~매도 시점을 함께 보여줘 특정 시기에 몰려 있는지 확인한다.
 *
 * 필요 환경변수: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   tsx --conditions=react-server scripts/diagnose-portfolio-allocation-simulation.ts
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
  type StrategyRule,
  type DailyPrice,
  type MinerviniParams,
  type BacktestTrade,
} from "@/lib/backtest";
import { STOCK_DATA_CANDIDATE_MARKET_CAP_EOK } from "@/lib/stockDataConfig";
import type { ListedSharesByFiscalYear } from "@/lib/pegRatio";

const UNIVERSE_START_YEAR = 2016;
const CURRENT_YEAR = new Date().getUTCFullYear();
const TODAY = new Date().toISOString().slice(0, 10);
const PRICE_FETCH_START_DATE = "2014-01-01";
const WINDOW_START_DATE = `${UNIVERSE_START_YEAR}-01-01`;

const BATCH_CONCURRENCY = 10;
const PROGRESS_LOG_INTERVAL = 100;
const TOP_CONTRIBUTOR_EXCLUDE_COUNT = 8;
const ANNUALIZATION_TRADING_DAYS = 252;

const FALLBACK_MINERVINI_PARAMS: MinerviniParams = { ma_short: 50, ma_mid: 150, ma_long: 200 };

const TARGET_RULE_TYPES = ["minervini_trend_template", "peg_lynch", "reversal_breakout"] as const;
type TargetRuleType = (typeof TARGET_RULE_TYPES)[number];

interface StockContribution {
  multiplier: number;
  tradeCount: number;
  heldDays: number;
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

async function loadActiveMinerviniParams(): Promise<Record<string, unknown> | null> {
  const { data, error } = await supabaseAdmin
    .from("strategies")
    .select("rule_params")
    .eq("rule_type", "minervini_trend_template")
    .eq("market", "KR")
    .limit(1);
  if (error) throw new Error(`minervini_trend_template 활성 전략 조회 실패: ${error.message}`);
  return data && data.length > 0 ? (data[0].rule_params as Record<string, unknown>) : null;
}

function computeCumulativeAndMdd(dailyReturnsPct: number[]): { totalReturnPct: number; mddPct: number } {
  let index = 100;
  let peak = 100;
  let maxDrawdownPct = 0;
  for (const r of dailyReturnsPct) {
    index *= 1 + r / 100;
    if (index > peak) peak = index;
    const drawdownPct = ((peak - index) / peak) * 100;
    if (drawdownPct > maxDrawdownPct) maxDrawdownPct = drawdownPct;
  }
  return { totalReturnPct: index - 100, mddPct: maxDrawdownPct };
}

function computeStats(
  dates: string[],
  dailyReturnsPct: number[]
): { totalReturnPct: number; cagrPct: number; mddPct: number; sharpe: number } {
  const { totalReturnPct, mddPct } = computeCumulativeAndMdd(dailyReturnsPct);

  const firstDate = new Date(`${dates[0]}T00:00:00Z`).getTime();
  const lastDate = new Date(`${dates[dates.length - 1]}T00:00:00Z`).getTime();
  const years = (lastDate - firstDate) / (365.25 * 24 * 60 * 60 * 1000);
  const cagrPct = years > 0 ? ((Math.pow(1 + totalReturnPct / 100, 1 / years) - 1) * 100) : 0;

  const decimalReturns = dailyReturnsPct.map((r) => r / 100);
  const mean = decimalReturns.reduce((s, v) => s + v, 0) / decimalReturns.length;
  const variance = decimalReturns.reduce((s, v) => s + (v - mean) ** 2, 0) / decimalReturns.length;
  const std = Math.sqrt(variance);
  const sharpe = std === 0 ? 0 : (mean / std) * Math.sqrt(ANNUALIZATION_TRADING_DAYS);

  return { totalReturnPct, cagrPct, mddPct, sharpe };
}

function combineWeighted(seriesList: { series: number[]; weight: number }[]): number[] {
  const length = seriesList[0].series.length;
  const combined = new Array(length).fill(0);
  for (const { series, weight } of seriesList) {
    for (let i = 0; i < length; i++) combined[i] += series[i] * weight;
  }
  return combined;
}

async function main(): Promise<void> {
  console.log(`포트폴리오 배분 시뮬레이션 시작: ${new Date().toISOString()}`);

  const minerviniActive = await loadActiveMinerviniParams();
  const minerviniParams = (minerviniActive as unknown as MinerviniParams | null) ?? FALLBACK_MINERVINI_PARAMS;
  console.log(`minervini_trend_template params: ${JSON.stringify(minerviniParams)}`);

  const RULES: Record<TargetRuleType, StrategyRule> = {
    minervini_trend_template: { rule_type: "minervini_trend_template", rule_params: minerviniParams },
    peg_lynch: { rule_type: "peg_lynch", rule_params: {} },
    reversal_breakout: { rule_type: "reversal_breakout", rule_params: {} },
  };

  const discoveryYears = Array.from(
    { length: CURRENT_YEAR - UNIVERSE_START_YEAR + 1 },
    (_, i) => UNIVERSE_START_YEAR + i
  );
  const universe = await discoverCandidateStockCodes(discoveryYears, STOCK_DATA_CANDIDATE_MARKET_CAP_EOK);
  console.log(`유니버스: ${universe.length}개 종목`);

  const allDates = new Set<string>();
  const dailyReturnSum: Record<TargetRuleType, Map<string, number>> = {
    minervini_trend_template: new Map(),
    peg_lynch: new Map(),
    reversal_breakout: new Map(),
  };
  const dailyActiveCount: Record<TargetRuleType, Map<string, number>> = {
    minervini_trend_template: new Map(),
    peg_lynch: new Map(),
    reversal_breakout: new Map(),
  };
  const perStockContribution: Record<TargetRuleType, Map<string, StockContribution>> = {
    minervini_trend_template: new Map(),
    peg_lynch: new Map(),
    reversal_breakout: new Map(),
  };
  const perStockDateReturn: Record<TargetRuleType, Map<string, Array<{ code: string; ret: number }>>> = {
    minervini_trend_template: new Map(),
    peg_lynch: new Map(),
    reversal_breakout: new Map(),
  };
  const reversalTradesByStock = new Map<string, BacktestTrade[]>();

  let completed = 0;
  await runWithConcurrency(universe, BATCH_CONCURRENCY, async (stockCode) => {
    try {
      const priceRows = await getDailyPriceSeries(stockCode, PRICE_FETCH_START_DATE, TODAY);
      if (priceRows.length === 0) return;

      const prices = priceRows.map(toDailyPrice);
      const dateIndex = new Map(prices.map((p, i) => [p.date, i]));
      for (const p of prices) {
        if (p.date >= WINDOW_START_DATE) allDates.add(p.date);
      }

      let fundamentals: FundamentalsSeries | undefined;
      let listedSharesByFiscalYear: ListedSharesByFiscalYear | undefined;
      try {
        const loaded = await loadFundamentalsSeriesWithListedShares(stockCode);
        fundamentals = loaded.series;
        listedSharesByFiscalYear = loaded.listedSharesByFiscalYear;
      } catch {
        // peg_lynch만 영향 — 조용히 건너뛴다.
      }

      for (const ruleType of TARGET_RULE_TYPES) {
        const needsFundamentals = ruleType === "peg_lynch";
        if (needsFundamentals && !fundamentals) continue;

        const result = runBacktest(
          prices,
          RULES[ruleType],
          WINDOW_START_DATE,
          needsFundamentals ? fundamentals : undefined,
          needsFundamentals ? listedSharesByFiscalYear : undefined
        );
        if (result.insufficientData || result.trades.length === 0) continue;

        if (ruleType === "reversal_breakout") {
          reversalTradesByStock.set(stockCode, result.trades);
        }

        const contribution: StockContribution = perStockContribution[ruleType].get(stockCode) ?? {
          multiplier: 1,
          tradeCount: 0,
          heldDays: 0,
        };
        contribution.tradeCount += result.trades.length;

        for (const trade of result.trades) {
          const buyIdx = dateIndex.get(trade.buyDate);
          const sellIdx = dateIndex.get(trade.sellDate);
          if (buyIdx === undefined || sellIdx === undefined) continue;

          for (let i = buyIdx + 1; i <= sellIdx; i++) {
            const date = prices[i].date;
            if (date < WINDOW_START_DATE) continue;
            const dailyReturn = (prices[i].close - prices[i - 1].close) / prices[i - 1].close;

            dailyReturnSum[ruleType].set(date, (dailyReturnSum[ruleType].get(date) ?? 0) + dailyReturn);
            dailyActiveCount[ruleType].set(date, (dailyActiveCount[ruleType].get(date) ?? 0) + 1);

            contribution.multiplier *= 1 + dailyReturn;
            contribution.heldDays++;

            const arr = perStockDateReturn[ruleType].get(date) ?? [];
            arr.push({ code: stockCode, ret: dailyReturn });
            perStockDateReturn[ruleType].set(date, arr);
          }
        }

        perStockContribution[ruleType].set(stockCode, contribution);
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

  const sortedDates = Array.from(allDates).sort();
  console.log(`\n전체 거래일수: ${sortedDates.length}일 (${sortedDates[0]} ~ ${sortedDates[sortedDates.length - 1]})`);

  function avgSeries(ruleType: TargetRuleType): number[] {
    return sortedDates.map((d) => {
      const count = dailyActiveCount[ruleType].get(d) ?? 0;
      if (count === 0) return 0;
      return ((dailyReturnSum[ruleType].get(d) ?? 0) / count) * 100;
    });
  }

  const minerviniSeries = avgSeries("minervini_trend_template");
  const pegSeries = avgSeries("peg_lynch");
  const reversalSeries = avgSeries("reversal_breakout");

  // === 1. minervini/peg_lynch 종목 쏠림 재확인 ===
  console.log("\n=== 1. minervini/peg_lynch 종목 쏠림 확인 ===");
  for (const ruleType of ["minervini_trend_template", "peg_lynch"] as const) {
    const ranked = Array.from(perStockContribution[ruleType].entries())
      .map(([code, c]) => ({ code, ownReturnPct: (c.multiplier - 1) * 100, tradeCount: c.tradeCount, heldDays: c.heldDays }))
      .sort((a, b) => b.ownReturnPct - a.ownReturnPct);

    const top = ranked.slice(0, TOP_CONTRIBUTOR_EXCLUDE_COUNT);
    console.log(`\n[${ruleType}] 종목 자체수익률 상위 ${TOP_CONTRIBUTOR_EXCLUDE_COUNT}개:`);
    for (const t of top) {
      console.log(`    ${t.code}: 자체수익률 ${t.ownReturnPct.toFixed(1)}%, 거래 ${t.tradeCount}건, 보유일 ${t.heldDays}일`);
    }

    const excludeSet = new Set(top.map((t) => t.code));
    const excludedSeries = sortedDates.map((d) => {
      const entries = (perStockDateReturn[ruleType].get(d) ?? []).filter((e) => !excludeSet.has(e.code));
      if (entries.length === 0) return 0;
      return (entries.reduce((s, e) => s + e.ret, 0) / entries.length) * 100;
    });

    const original = computeCumulativeAndMdd(ruleType === "minervini_trend_template" ? minerviniSeries : pegSeries);
    const excluded = computeCumulativeAndMdd(excludedSeries);
    console.log(`  [${ruleType}] 전체: 누적수익률 ${original.totalReturnPct.toFixed(1)}%, MDD ${original.mddPct.toFixed(1)}%`);
    console.log(
      `  [${ruleType}] 상위 ${TOP_CONTRIBUTOR_EXCLUDE_COUNT}개 제외: 누적수익률 ${excluded.totalReturnPct.toFixed(1)}%, MDD ${excluded.mddPct.toFixed(1)}%`
    );
  }

  // === 2. minervini:peg_lynch 비중별 결합 시뮬레이션 ===
  console.log("\n=== 2. minervini:peg_lynch 비중별 결합 시뮬레이션 ===");
  const singleStats = {
    minervini: computeStats(sortedDates, minerviniSeries),
    peg_lynch: computeStats(sortedDates, pegSeries),
    reversal_breakout: computeStats(sortedDates, reversalSeries),
  };
  console.log(
    `  [minervini 100%] 누적 ${singleStats.minervini.totalReturnPct.toFixed(1)}%, CAGR ${singleStats.minervini.cagrPct.toFixed(1)}%, MDD ${singleStats.minervini.mddPct.toFixed(1)}%, Sharpe ${singleStats.minervini.sharpe.toFixed(2)}`
  );
  console.log(
    `  [peg_lynch 100%] 누적 ${singleStats.peg_lynch.totalReturnPct.toFixed(1)}%, CAGR ${singleStats.peg_lynch.cagrPct.toFixed(1)}%, MDD ${singleStats.peg_lynch.mddPct.toFixed(1)}%, Sharpe ${singleStats.peg_lynch.sharpe.toFixed(2)}`
  );

  const twoAssetWeights = [
    { minervini: 0.5, peg: 0.5, label: "50:50" },
    { minervini: 0.7, peg: 0.3, label: "70:30" },
    { minervini: 0.3, peg: 0.7, label: "30:70" },
    { minervini: 0.6, peg: 0.4, label: "60:40(임시 핵심안)" },
  ];
  for (const w of twoAssetWeights) {
    const combined = combineWeighted([
      { series: minerviniSeries, weight: w.minervini },
      { series: pegSeries, weight: w.peg },
    ]);
    const stats = computeStats(sortedDates, combined);
    console.log(
      `  [minervini:peg_lynch = ${w.label}] 누적 ${stats.totalReturnPct.toFixed(1)}%, CAGR ${stats.cagrPct.toFixed(1)}%, MDD ${stats.mddPct.toFixed(1)}%, Sharpe ${stats.sharpe.toFixed(2)}`
    );
  }

  // === 3. reversal_breakout 위성 슬롯 추가 ===
  console.log("\n=== 3. reversal_breakout 위성 슬롯 추가(60:40 핵심안 기준) ===");
  console.log(`  [reversal_breakout 100%, 참고용] 누적 ${singleStats.reversal_breakout.totalReturnPct.toFixed(1)}%, CAGR ${singleStats.reversal_breakout.cagrPct.toFixed(1)}%, MDD ${singleStats.reversal_breakout.mddPct.toFixed(1)}%, Sharpe ${singleStats.reversal_breakout.sharpe.toFixed(2)}`);

  const satelliteWeights = [0, 0.05, 0.1];
  for (const satWeight of satelliteWeights) {
    const coreWeight = 1 - satWeight;
    const minerviniWeight = 0.6 * coreWeight;
    const pegWeight = 0.4 * coreWeight;
    const combined = combineWeighted([
      { series: minerviniSeries, weight: minerviniWeight },
      { series: pegSeries, weight: pegWeight },
      { series: reversalSeries, weight: satWeight },
    ]);
    const stats = computeStats(sortedDates, combined);
    console.log(
      `  [minervini ${(minerviniWeight * 100).toFixed(0)}% : peg_lynch ${(pegWeight * 100).toFixed(0)}% : reversal_breakout ${(satWeight * 100).toFixed(0)}%] ` +
        `누적 ${stats.totalReturnPct.toFixed(1)}%, CAGR ${stats.cagrPct.toFixed(1)}%, MDD ${stats.mddPct.toFixed(1)}%, Sharpe ${stats.sharpe.toFixed(2)}`
    );
  }

  // === reversal_breakout 상위 기여 종목의 실제 매수~매도 시점 ===
  console.log("\n=== reversal_breakout 상위 기여 종목 거래 시점 ===");
  const reversalRanked = Array.from(perStockContribution.reversal_breakout.entries())
    .map(([code, c]) => ({ code, ownReturnPct: (c.multiplier - 1) * 100 }))
    .sort((a, b) => b.ownReturnPct - a.ownReturnPct)
    .slice(0, TOP_CONTRIBUTOR_EXCLUDE_COUNT);

  for (const r of reversalRanked) {
    const trades = reversalTradesByStock.get(r.code) ?? [];
    console.log(`\n  [${r.code}] 자체수익률 ${r.ownReturnPct.toFixed(1)}%, 거래 ${trades.length}건:`);
    for (const t of trades) {
      console.log(
        `    ${t.buyDate} → ${t.sellDate}: ${(t.returnPct * 100).toFixed(1)}%${t.isForcedLiquidation ? " (기간 끝 강제청산)" : ""}`
      );
    }
  }

  console.log("\n완료");
}

main().catch((error) => {
  console.error("진단 중 오류:", error);
  process.exit(1);
});
