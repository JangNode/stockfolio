/**
 * 디스포저블 진단(쓰기 없음): 좁은/넓은 원자료에서 minervini_trend_template와
 * reversal_breakout_v2를 같은 유니버스·같은 조건(비용 반영/미반영 각각)으로 계산해 비교한다.
 * "좁은 데이터"는 현재 넓은 Parquet에서 옛 저장 필터(시총 5천억 미만이면서 테마 소속이
 * 아닌 행 제외)를 재현해 만든 근사치다(옛 reversal_breakout 이력/상장폐지 예외 종목은
 * 후보 유니버스(1조원 이상 이력) 밖이 대부분이라 무시).
 *
 * 실행: npm run diagnose:wide-vs-narrow-backtest
 */

import { loadCandidateSeriesFromParquet, type StockDailyPriceRow } from "@/lib/stockDailyPricesStorage";
import { runBacktest, type BacktestTrade, type DailyPrice, type StrategyRule } from "@/lib/backtest";
import { STOCK_DATA_BACKFILL_MARKET_CAP_FLOOR_EOK, STOCK_DATA_CANDIDATE_MARKET_CAP_EOK } from "@/lib/stockDataConfig";
import { getThemeFlaggedStockCodes } from "@/lib/stockMaster";
import {
  STRATEGY_BACKTEST_WINDOW_START_YEAR,
  FALLBACK_MINERVINI_PARAMS,
} from "@/lib/strategyBacktestSummaryConfig";
import {
  accumulateStockDailyReturns,
  computeCumulativeAndMdd,
  computeCagrPct,
  type DailyStockReturns,
  type StockContribution,
} from "@/lib/strategyBacktestSummary";

const TODAY = new Date().toISOString().slice(0, 10);
const PERIOD_START_DATE = `${STRATEGY_BACKTEST_WINDOW_START_YEAR}-01-01`;
const PRICE_FETCH_START_DATE = "2014-01-01";

const RULES: { name: string; rule: StrategyRule }[] = [
  { name: "minervini_trend_template", rule: { rule_type: "minervini_trend_template", rule_params: FALLBACK_MINERVINI_PARAMS } },
  { name: "reversal_breakout_v2", rule: { rule_type: "reversal_breakout_v2", rule_params: {} } },
];

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

interface RunResult {
  cagrPct: number;
  mddPct: number;
  trades: number;
  yearlyReturnPct: Map<string, number>;
  belowFloorTrades: number;
  belowFloorAvgReturnPct: number;
}

function runOne(
  rule: StrategyRule,
  seriesByCode: Map<string, StockDailyPriceRow[]>,
  includeCosts: boolean,
  floorCapByStockDate: Map<string, boolean>
): RunResult {
  const dailyReturns: DailyStockReturns = new Map();
  const contributions = new Map<string, StockContribution>();
  let trades = 0;
  let belowFloor = 0;
  let belowFloorReturnSum = 0;

  for (const [code, rows] of seriesByCode) {
    if (rows.length === 0) continue;
    const prices = rows.map(toDailyPrice);
    const result = runBacktest(prices, rule, PERIOD_START_DATE, undefined, undefined, {
      market: "KR",
      includeTransactionCosts: includeCosts,
    });
    if (result.insufficientData || result.trades.length === 0) continue;
    trades += result.trades.length;
    for (const t of result.trades as BacktestTrade[]) {
      if (floorCapByStockDate.get(`${code}:${t.buyDate}`)) {
        belowFloor++;
        belowFloorReturnSum += t.returnPct * 100;
      }
    }
    accumulateStockDailyReturns(dailyReturns, contributions, code, prices, result.trades, PERIOD_START_DATE, "KR", includeCosts);
  }

  const dates = Array.from(dailyReturns.keys()).sort();
  const daily = dates.map((d) => {
    const entries = dailyReturns.get(d) ?? [];
    return entries.length === 0 ? 0 : (entries.reduce((s, e) => s + e.returnPct, 0) / entries.length) * 100;
  });
  const { totalReturnPct, mddPct } = computeCumulativeAndMdd(daily);
  const cagrPct = computeCagrPct(totalReturnPct, PERIOD_START_DATE, TODAY);

  const yearIndex = new Map<string, number>();
  dates.forEach((d, i) => {
    const y = d.slice(0, 4);
    yearIndex.set(y, (yearIndex.get(y) ?? 1) * (1 + daily[i] / 100));
  });
  const yearlyReturnPct = new Map<string, number>();
  for (const [y, mult] of yearIndex) yearlyReturnPct.set(y, (mult - 1) * 100);

  return {
    cagrPct,
    mddPct,
    trades,
    yearlyReturnPct,
    belowFloorTrades: belowFloor,
    belowFloorAvgReturnPct: belowFloor > 0 ? belowFloorReturnSum / belowFloor : 0,
  };
}

async function main(): Promise<void> {
  const discoveryYears = Array.from(
    { length: new Date().getUTCFullYear() - STRATEGY_BACKTEST_WINDOW_START_YEAR + 1 },
    (_, i) => STRATEGY_BACKTEST_WINDOW_START_YEAR + i
  );
  const { seriesByCode: wide } = await loadCandidateSeriesFromParquet(
    discoveryYears,
    STOCK_DATA_CANDIDATE_MARKET_CAP_EOK,
    PRICE_FETCH_START_DATE,
    TODAY
  );
  const themeFlagged = await getThemeFlaggedStockCodes();

  const narrow = new Map<string, StockDailyPriceRow[]>();
  const belowFloorByStockDate = new Map<string, boolean>();
  let wideRows = 0;
  let narrowRows = 0;
  for (const [code, rows] of wide) {
    wideRows += rows.length;
    const kept = rows.filter((r) => r.marketCapEok >= STOCK_DATA_BACKFILL_MARKET_CAP_FLOOR_EOK || themeFlagged.has(code));
    narrowRows += kept.length;
    narrow.set(code, kept);
    for (const r of rows) {
      if (r.marketCapEok < STOCK_DATA_BACKFILL_MARKET_CAP_FLOOR_EOK && !themeFlagged.has(code)) {
        belowFloorByStockDate.set(`${code}:${r.tradeDate}`, true);
      }
    }
  }
  console.log(`유니버스 ${wide.size}종목, 후보 종목 행 수 넓음 ${wideRows} vs 좁음(재현) ${narrowRows}`);

  for (const { name, rule } of RULES) {
    console.log(`\n=== ${name} ===`);
    console.log("데이터 | 비용 | CAGR% | MDD% | 거래건수 | (넓은 데이터) 시총5천억 미만일 진입 거래수/평균수익률%");
    const results = new Map<string, RunResult>();
    for (const [label, data] of [
      ["좁음", narrow],
      ["넓음", wide],
    ] as const) {
      for (const includeCosts of [true, false]) {
        const r = runOne(rule, data, includeCosts, label === "넓음" ? belowFloorByStockDate : new Map());
        results.set(`${label}:${includeCosts}`, r);
        console.log(
          `${label} | ${includeCosts ? "반영" : "미반영"} | ${r.cagrPct.toFixed(1)} | ${r.mddPct.toFixed(1)} | ${r.trades} | ` +
            (label === "넓음" ? `${r.belowFloorTrades}/${r.belowFloorAvgReturnPct.toFixed(1)}` : "-")
        );
      }
    }
    // 비용 반영 기준 연도별 수익률 차이(넓음-좁음) 상위 3개.
    const n = results.get("좁음:true")!;
    const w = results.get("넓음:true")!;
    const diffs = Array.from(w.yearlyReturnPct.keys())
      .map((y) => ({
        year: y,
        narrow: n.yearlyReturnPct.get(y) ?? 0,
        wide: w.yearlyReturnPct.get(y) ?? 0,
        diff: (w.yearlyReturnPct.get(y) ?? 0) - (n.yearlyReturnPct.get(y) ?? 0),
      }))
      .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
    console.log("연도별 수익률 차이(비용 반영, |차이| 상위 3개): 연도 | 좁음% | 넓음% | 차이%p");
    for (const d of diffs.slice(0, 3)) {
      console.log(`${d.year} | ${d.narrow.toFixed(1)} | ${d.wide.toFixed(1)} | ${d.diff.toFixed(1)}`);
    }
  }
}

main().catch((error) => {
  console.error("진단 중 오류:", error);
  process.exit(1);
});
