/**
 * [디스포저블 진단 스크립트, 1회성] "장기 백테스트" 카드에 넣을 벤치마크 비교
 * 조사(2026-09-29)용. DB에는 아무것도 쓰지 않는다(순수 조회 + 계산 + 콘솔 출력).
 *
 * scripts/compute-strategy-backtest-summary.ts와 동일한 유니버스/가격
 * Storage(lib/stockDailyPricesStorage.ts)·백테스트 엔진(lib/backtest.ts)·날짜단위
 * 동일가중 집계(lib/strategyBacktestSummary.ts)를 그대로 재사용해 다음을 계산한다:
 *
 * 1) 5개 전략(ma_cross/minervini_trend_template/reversal_breakout/
 *    reversal_breakout_v2/peg_lynch)의 "시장참여비율"(보유종목 1개 이상인 날 ÷
 *    코스피 거래일수)과 "평균 보유종목수"(코스피 거래일 전체 기준 평균),
 *    연도별(2016~) 동일가중 수익률.
 * 2) 유니버스(672종목) 동일가중 벤치마크 2종:
 *    - buy-and-hold: PERIOD_START_DATE 이전부터 이미 상장돼 있던 종목만 동일금액
 *      매수 후 리밸런싱 없음(이후 상장 종목 추가매수 없음). 상장폐지 종목은
 *      마지막 종가에서 가치를 그대로 동결(생존편향 보정 시세가 상폐일 이후 행이
 *      없다는 점을 그대로 이용).
 *    - 월간 리밸런싱: 매월 첫 거래일에 그 시점까지 상장 중(point-in-time)인 종목
 *      전체를 동일가중으로 재조정.
 *   각각 CAGR/MDD/연도별 수익률.
 * 3) 코스피/코스닥 지수(beta_price_history) CAGR/MDD/연도별 수익률(백필이 안 돼
 *    있으면 있는 구간만).
 *
 * 실행: tsx --conditions=react-server scripts/diagnose-benchmark-comparison.ts
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
  type StrategyRule,
  type DailyPrice,
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
  computeCumulativeAndMdd,
  computeCagrPct,
  type DailyStockReturns,
  type StockContribution,
} from "@/lib/strategyBacktestSummary";
import { getIndexPriceSeries } from "@/lib/betaPriceHistoryStorage";

const CURRENT_YEAR = new Date().getUTCFullYear();
const TODAY = new Date().toISOString().slice(0, 10);
const PERIOD_START_DATE = `${STRATEGY_BACKTEST_WINDOW_START_YEAR}-01-01`;
const PRICE_FETCH_START_DATE = "2014-01-01";
// 이미 상장돼 있었다고 볼 첫 거래일 기준(2016-01-04 근처) 여유. 이 날짜 이전에도
// 시세가 있으면 "이미 상장" 취급 — buy-and-hold 초기 편입 대상.
const ALREADY_LISTED_THRESHOLD_DATE = "2016-01-10";

const BATCH_CONCURRENCY = 10;
const PROGRESS_LOG_INTERVAL = 100;

const TARGET_RULE_TYPES = STRATEGY_BACKTEST_TARGET_RULE_TYPES;
type TargetRuleType = (typeof TARGET_RULE_TYPES)[number];

const YEARS = Array.from({ length: CURRENT_YEAR - STRATEGY_BACKTEST_WINDOW_START_YEAR + 1 }, (_, i) => STRATEGY_BACKTEST_WINDOW_START_YEAR + i);

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

/** 날짜(YYYY-MM-DD)별 수익률(%) 시계열을 연도별 수익률(%)로 묶는다. 데이터가 없는
 * 해는 지수 변화가 없다고 보고 0%로 취급한다(건너뛴 날 = 0% 곱과 동치). */
function groupYearlyReturnsPct(dailyReturnsPctWithDates: { date: string; returnPct: number }[], years: number[]): Map<number, number> {
  let index = 100;
  const indexAtYearEnd = new Map<number, number>();
  for (const { date, returnPct } of dailyReturnsPctWithDates) {
    index *= 1 + returnPct / 100;
    indexAtYearEnd.set(Number(date.slice(0, 4)), index);
  }
  const result = new Map<number, number>();
  let prevIndex = 100;
  for (const y of years) {
    const end = indexAtYearEnd.has(y) ? indexAtYearEnd.get(y)! : prevIndex;
    result.set(y, (end / prevIndex - 1) * 100);
    prevIndex = end;
  }
  return result;
}

function equalWeightDailyReturnsWithDates(dailyReturns: DailyStockReturns): { date: string; returnPct: number }[] {
  const dates = Array.from(dailyReturns.keys()).sort();
  return dates.map((date) => {
    const entries = dailyReturns.get(date) ?? [];
    if (entries.length === 0) return { date, returnPct: 0 };
    const avg = entries.reduce((sum, e) => sum + e.returnPct, 0) / entries.length;
    return { date, returnPct: avg * 100 };
  });
}

function formatPct(v: number): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}

function printYearlyTable(label: string, yearlyMap: Map<number, number>): void {
  const parts = YEARS.map((y) => `${y}: ${formatPct(yearlyMap.get(y) ?? 0)}`);
  console.log(`  [${label}] ${parts.join(", ")}`);
}

interface StockPriceInfo {
  dates: string[]; // PERIOD_START_DATE 이후만, 오름차순
  byDate: Map<string, number>; // date -> close
  alreadyListedAtStart: boolean;
}

interface RuleTypeAccumulator {
  dailyReturns: DailyStockReturns;
  positionCountByDate: Map<string, number>;
}

function createAccumulator(): RuleTypeAccumulator {
  return { dailyReturns: new Map(), positionCountByDate: new Map() };
}

async function main(): Promise<void> {
  console.log(`벤치마크 비교 진단 시작: ${new Date().toISOString()}`);

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

  const discoveryYears = Array.from({ length: CURRENT_YEAR - STRATEGY_BACKTEST_WINDOW_START_YEAR + 1 }, (_, i) => STRATEGY_BACKTEST_WINDOW_START_YEAR + i);
  const universe = await discoverCandidateStockCodes(discoveryYears, STOCK_DATA_CANDIDATE_MARKET_CAP_EOK);
  console.log(`유니버스: ${universe.length}개 종목`);

  const accumulators: Record<TargetRuleType, RuleTypeAccumulator> = {
    ma_cross: createAccumulator(),
    minervini_trend_template: createAccumulator(),
    reversal_breakout: createAccumulator(),
    reversal_breakout_v2: createAccumulator(),
    peg_lynch: createAccumulator(),
  };

  const stockPriceInfos = new Map<string, StockPriceInfo>();

  let completed = 0;
  await runWithConcurrency(universe, BATCH_CONCURRENCY, async (stockCode) => {
    try {
      const priceRows = await getDailyPriceSeries(stockCode, PRICE_FETCH_START_DATE, TODAY);
      if (priceRows.length === 0) return;

      const prices = priceRows.map(toDailyPrice);
      const dateIndex = new Map(prices.map((p, i) => [p.date, i]));

      // 벤치마크(BH/월간 리밸런싱)용 — PERIOD_START_DATE 이후 구간만 보관.
      const periodPrices = prices.filter((p) => p.date >= PERIOD_START_DATE);
      if (periodPrices.length > 0) {
        const byDate = new Map(periodPrices.map((p) => [p.date, p.close]));
        stockPriceInfos.set(stockCode, {
          dates: periodPrices.map((p) => p.date),
          byDate,
          alreadyListedAtStart: prices[0].date <= ALREADY_LISTED_THRESHOLD_DATE,
        });
      }

      let fundamentals: FundamentalsSeries | undefined;
      let listedSharesByFiscalYear: ListedSharesByFiscalYear | undefined;
      try {
        const loaded = await loadFundamentalsSeriesWithListedShares(stockCode);
        fundamentals = loaded.series;
        listedSharesByFiscalYear = loaded.listedSharesByFiscalYear;
      } catch {
        // peg_lynch만 영향(재무 조회 실패 시 그 종목은 peg_lynch 판정에서만 제외).
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
          { market: "KR" }
        );
        if (result.insufficientData || result.trades.length === 0) continue;

        const acc = accumulators[ruleType];
        accumulateStockDailyReturns(acc.dailyReturns, new Map<string, StockContribution>(), stockCode, prices, result.trades, PERIOD_START_DATE, "KR");

        // 시장참여비율/평균 보유종목수용 — 거래별 보유구간(매수일~매도일 포함)의
        // 날짜마다 포지션 카운트 +1.
        for (const trade of result.trades) {
          const buyIdx = dateIndex.get(trade.buyDate);
          const sellIdx = dateIndex.get(trade.sellDate);
          if (buyIdx === undefined || sellIdx === undefined) continue;
          for (let i = buyIdx; i <= sellIdx; i++) {
            const date = prices[i].date;
            if (date < PERIOD_START_DATE) continue;
            acc.positionCountByDate.set(date, (acc.positionCountByDate.get(date) ?? 0) + 1);
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

  // 코스피 지수를 거래일 캘린더(마스터 캘린더)로 쓴다. 백필이 안 돼 있으면(2016년까지
  // 못 미치면) 유니버스 종목 날짜 union으로 대체한다.
  const kospiSeries = await getIndexPriceSeries("KOSPI", PERIOD_START_DATE, TODAY);
  const kosdaqSeries = await getIndexPriceSeries("KOSDAQ", PERIOD_START_DATE, TODAY);

  let masterDates: string[];
  if (kospiSeries.length > 0 && kospiSeries[0].tradeDate <= ALREADY_LISTED_THRESHOLD_DATE) {
    masterDates = kospiSeries.map((p) => p.tradeDate);
    console.log(`마스터 거래일 캘린더: 코스피 지수 기준 ${masterDates.length}일 (${masterDates[0]} ~ ${masterDates[masterDates.length - 1]})`);
  } else {
    const dateSet = new Set<string>();
    for (const info of stockPriceInfos.values()) for (const d of info.dates) dateSet.add(d);
    masterDates = Array.from(dateSet).sort();
    console.log(`마스터 거래일 캘린더: 코스피 지수 백필 부족 — 종목 union 대체, ${masterDates.length}일`);
  }

  console.log("\n=== 1) 전략별 시장참여비율 / 평균 보유종목수 / 연도별 수익률 ===");
  for (const ruleType of TARGET_RULE_TYPES) {
    const acc = accumulators[ruleType];
    let daysWithPosition = 0;
    let totalPositionSum = 0;
    for (const date of masterDates) {
      const count = acc.positionCountByDate.get(date) ?? 0;
      if (count > 0) daysWithPosition++;
      totalPositionSum += count;
    }
    const participationRatio = masterDates.length > 0 ? daysWithPosition / masterDates.length : 0;
    const avgHoldings = masterDates.length > 0 ? totalPositionSum / masterDates.length : 0;
    console.log(`[${ruleType}] 시장참여비율 ${(participationRatio * 100).toFixed(1)}%, 평균 보유종목수 ${avgHoldings.toFixed(2)}개`);
    const withDates = equalWeightDailyReturnsWithDates(acc.dailyReturns);
    printYearlyTable(ruleType, groupYearlyReturnsPct(withDates, YEARS));
  }

  console.log("\n=== 2) 유니버스 동일가중 벤치마크 ===");

  // --- Buy & Hold ---
  const bhStocks = Array.from(stockPriceInfos.entries()).filter(([, info]) => info.alreadyListedAtStart);
  console.log(`buy-and-hold 편입 종목: ${bhStocks.length}개 (전체 유니버스 ${stockPriceInfos.size}개 중 이미 상장됐던 종목만)`);

  const bhGrowthState = new Map<string, { lastValue: number; started: boolean }>();
  for (const [code] of bhStocks) bhGrowthState.set(code, { lastValue: 1, started: false });
  const bhBasePrices = new Map<string, number>();

  const bhDailyReturnsWithDates: { date: string; returnPct: number }[] = [];
  let prevPortfolioValue: number | null = null;
  for (const date of masterDates) {
    let sum = 0;
    let n = 0;
    for (const [code, info] of bhStocks) {
      const state = bhGrowthState.get(code)!;
      const price = info.byDate.get(date);
      if (price !== undefined) {
        if (!bhBasePrices.has(code)) bhBasePrices.set(code, price);
        state.lastValue = price / bhBasePrices.get(code)!;
        state.started = true;
      }
      if (state.started) {
        sum += state.lastValue;
        n++;
      }
    }
    if (n === 0) continue;
    const portfolioValue = sum / n;
    if (prevPortfolioValue !== null) {
      bhDailyReturnsWithDates.push({ date, returnPct: (portfolioValue / prevPortfolioValue - 1) * 100 });
    }
    prevPortfolioValue = portfolioValue;
  }
  const bhSeries = bhDailyReturnsWithDates.map((d) => d.returnPct);
  const { totalReturnPct: bhTotalReturnPct, mddPct: bhMddPct } = computeCumulativeAndMdd(bhSeries);
  const bhCagrPct = computeCagrPct(bhTotalReturnPct, PERIOD_START_DATE, TODAY);
  console.log(`[buy-and-hold] CAGR ${bhCagrPct.toFixed(1)}%, MDD ${bhMddPct.toFixed(1)}%, 칼마 ${(bhCagrPct / Math.abs(bhMddPct)).toFixed(2)}`);
  printYearlyTable("buy-and-hold", groupYearlyReturnsPct(bhDailyReturnsWithDates, YEARS));

  // --- 월간 리밸런싱 ---
  function firstDayOfMonthDates(dates: string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const d of dates) {
      const ym = d.slice(0, 7);
      if (!seen.has(ym)) {
        seen.add(ym);
        result.push(d);
      }
    }
    return result;
  }
  const rebalanceDates = new Set(firstDayOfMonthDates(masterDates));

  const monthlyDailyReturnsWithDates: { date: string; returnPct: number }[] = [];
  let basket: { code: string; info: StockPriceInfo; basePrice: number; lastValue: number }[] = [];
  let prevMonthlyValue = 1;

  for (const date of masterDates) {
    if (rebalanceDates.has(date)) {
      // point-in-time: 이 시점 이전에 상장(첫 데이터 <= date)했고 아직 상폐 전(마지막
      // 데이터 >= date)인 종목만 편입.
      const active: { code: string; info: StockPriceInfo }[] = [];
      for (const [code, info] of stockPriceInfos) {
        const first = info.dates[0];
        const last = info.dates[info.dates.length - 1];
        if (first <= date && last >= date) active.push({ code, info });
      }
      basket = active
        .map(({ code, info }) => {
          const basePrice = info.byDate.get(date);
          if (basePrice === undefined) return null;
          return { code, info, basePrice, lastValue: 1 };
        })
        .filter((b): b is { code: string; info: StockPriceInfo; basePrice: number; lastValue: number } => b !== null);
      prevMonthlyValue = 1;
    }

    if (basket.length === 0) continue;

    let sum = 0;
    for (const b of basket) {
      const price = b.info.byDate.get(date);
      if (price !== undefined) b.lastValue = price / b.basePrice;
      sum += b.lastValue;
    }
    // 리밸런싱 당일은 prevMonthlyValue가 방금 1로 리셋된 기준이라 수익률이 항상
    // 0%가 된다(그날 새 바스켓으로 막 갈아탄 시점이라는 뜻) — 의도된 동작이다.
    const value = sum / basket.length;
    monthlyDailyReturnsWithDates.push({ date, returnPct: (value / prevMonthlyValue - 1) * 100 });
    prevMonthlyValue = value;
  }
  const monthlySeries = monthlyDailyReturnsWithDates.map((d) => d.returnPct);
  const { totalReturnPct: monthlyTotalReturnPct, mddPct: monthlyMddPct } = computeCumulativeAndMdd(monthlySeries);
  const monthlyCagrPct = computeCagrPct(monthlyTotalReturnPct, PERIOD_START_DATE, TODAY);
  console.log(`[월간 리밸런싱] CAGR ${monthlyCagrPct.toFixed(1)}%, MDD ${monthlyMddPct.toFixed(1)}%, 칼마 ${(monthlyCagrPct / Math.abs(monthlyMddPct)).toFixed(2)}`);
  printYearlyTable("월간 리밸런싱", groupYearlyReturnsPct(monthlyDailyReturnsWithDates, YEARS));

  console.log("\n=== 3) 코스피/코스닥 지수 ===");
  function indexYearly(label: string, series: { tradeDate: string; closePrice: number }[]): void {
    if (series.length === 0) {
      console.log(`[${label}] 데이터 없음`);
      return;
    }
    const withDates: { date: string; returnPct: number }[] = [];
    for (let i = 1; i < series.length; i++) {
      withDates.push({ date: series[i].tradeDate, returnPct: (series[i].closePrice / series[i - 1].closePrice - 1) * 100 });
    }
    const returnSeries = withDates.map((d) => d.returnPct);
    const { totalReturnPct, mddPct } = computeCumulativeAndMdd(returnSeries);
    const cagrPct = computeCagrPct(totalReturnPct, series[0].tradeDate, series[series.length - 1].tradeDate);
    console.log(
      `[${label}] 데이터 구간 ${series[0].tradeDate} ~ ${series[series.length - 1].tradeDate}, CAGR ${cagrPct.toFixed(1)}%, MDD ${mddPct.toFixed(1)}%, 칼마 ${(cagrPct / Math.abs(mddPct)).toFixed(2)}`
    );
    printYearlyTable(label, groupYearlyReturnsPct(withDates, YEARS));
  }
  indexYearly("코스피", kospiSeries);
  indexYearly("코스닥", kosdaqSeries);

  console.log("\n완료");
}

main().catch((error) => {
  console.error("진단 중 오류:", error);
  process.exit(1);
});
