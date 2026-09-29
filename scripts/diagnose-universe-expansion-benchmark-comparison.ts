/**
 * [디스포저블 진단, 조사 끝나면 정리 PR로 제거] 백테스트 유니버스를 "시총 무관 전
 * 종목(상장폐지 포함), 시점별 편입"으로 넓히는 방안 조사(2026-09-29, PR-3와 무관한
 * 별도 조사)의 2단계 — 이미 저장된 데이터만으로 계산 가능한 범위 내에서 유니버스
 * 후보 3가지(A' 근사 전종목/B' 유동성 필터/C 현행 사후 1조원)를 비교한다. 새로운
 * 백필(KRX API 호출)은 전혀 하지 않는다 — 순수 조회+계산+콘솔 출력, DB에는 아무것도
 * 쓰지 않는다.
 *
 * - A'(근사): 현재 저장된 데이터에 등장하는 모든 종목(사후 시총 필터 없음). 진짜
 *   "전 종목"과 다른 점: 지금도 상장돼 있지만 한 번도 5천억원(저장 하한)을 넘지
 *   못했고 테마/역배열매칭/상장�레지 예외에도 안 걸린 소형주는 여전히 빠져 있다
 *   (규모는 diagnose-universe-expansion-data-landscape.ts 결과 참고).
 * - B'(유동성 필터): A'에 그 시점 직전 20거래일 평균 거래대금(거래량×종가로 근사)
 *   필터를 얹는다. 미래 정보(시총, 이후 상장폐지 여부)는 쓰지 않고 그 시점에 이미
 *   관측된 가격·거래량만 쓴다.
 * - C(현행): lib/stockDailyPricesStorage.ts의 discoverCandidateStockCodes를 그대로
 *   재사용(사후 1조원 선정, 기준선).
 *
 * lib/benchmarkSummary.ts의 simulateUniverseMonthlyRebalance(C, A'에 그대로 재사용)와
 * lib/strategyBacktestSummary.ts/lib/backtest.ts의 계산 함수를 그대로 재사용한다.
 * B'의 유동성 필터링 로직만 이 스크립트에 새로 작성한다(운영 코드를 건드리지 않기
 * 위해 diagnose-benchmark-reference-implementation.ts와 같은 관례로 독립 구현).
 *
 * 실행: tsx --conditions=react-server scripts/diagnose-universe-expansion-benchmark-comparison.ts
 * 필요 환경변수: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  discoverCandidateStockCodes,
  getDailyPriceSeries,
  downloadYearPrices,
  type StockDailyPriceRow,
} from "@/lib/stockDailyPricesStorage";
import { getIndexPriceSeries } from "@/lib/betaPriceHistoryStorage";
import { STOCK_DATA_CANDIDATE_MARKET_CAP_EOK } from "@/lib/stockDataConfig";
import { STRATEGY_BACKTEST_WINDOW_START_YEAR, FALLBACK_MA_CROSS_PARAMS } from "@/lib/strategyBacktestSummaryConfig";
import { runBacktest, aggregateTrades, type DailyPrice, type BacktestTrade } from "@/lib/backtest";
import {
  accumulateStockDailyReturns,
  computeEqualWeightDailyReturns,
  computeCumulativeAndMdd,
  computeCagrPct,
  type DailyStockReturns,
  type StockContribution,
} from "@/lib/strategyBacktestSummary";
import { simulateUniverseMonthlyRebalance, computeCalmarRatio } from "@/lib/benchmarkSummary";
import { computeEffectiveBuyPrice, computeEffectiveSellPrice } from "@/lib/transactionCost";

const HOT_TABLE = "stock_daily_prices_recent";
const HOT_TABLE_PAGE_SIZE = 1000;
const CURRENT_YEAR = new Date().getUTCFullYear();
const TODAY = new Date().toISOString().slice(0, 10);
const PERIOD_START_DATE = `${STRATEGY_BACKTEST_WINDOW_START_YEAR}-01-01`;
const PRICE_FETCH_START_DATE = "2014-01-01";
const BATCH_CONCURRENCY = 10;
const SNAPSHOT_MONTHS = ["2016-01", "2018-01", "2020-01", "2022-01", "2024-01", "2026-01"];
const LIQUIDITY_THRESHOLDS_WON = [
  { label: "1억원", value: 1 * 100_000_000 },
  { label: "5억원", value: 5 * 100_000_000 },
  { label: "10억원", value: 10 * 100_000_000 },
];
const TURNOVER_LOOKBACK_DAYS = 20;

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

async function fetchAllStoredCodes(): Promise<Set<string>> {
  const codes = new Set<string>();
  for (let year = 2011; year <= CURRENT_YEAR; year++) {
    const coldRows: StockDailyPriceRow[] = await downloadYearPrices(year);
    for (const r of coldRows) codes.add(r.stockCode);
  }
  let from = 0;
  for (;;) {
    const { data, error } = await supabaseAdmin.from(HOT_TABLE).select("stock_code").range(from, from + HOT_TABLE_PAGE_SIZE - 1);
    if (error) throw new Error(`hot 구간 전체 종목 조회 실패: ${error.message}`);
    for (const row of data ?? []) codes.add((row as { stock_code: string }).stock_code);
    if (!data || data.length < HOT_TABLE_PAGE_SIZE) break;
    from += HOT_TABLE_PAGE_SIZE;
  }
  return codes;
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

/** 종목별 종가×거래량(원) 시계열에서, dateToIndex를 이용해 각 날짜의 "직전
 * TURNOVER_LOOKBACK_DAYS거래일 평균 거래대금(그날 포함)"을 O(1)로 조회할 수 있는
 * 누적합 기반 조회기를 만든다. 미래 데이터를 쓰지 않는다(그 날짜 이전 데이터만). */
interface TurnoverLookup {
  dateToIndex: Map<string, number>;
  rollingAvgAt: (index: number) => number;
}

function buildTurnoverLookup(prices: DailyPrice[]): TurnoverLookup {
  const prefix: number[] = [0];
  for (const p of prices) prefix.push(prefix[prefix.length - 1] + p.close * p.volume);
  const dateToIndex = new Map<string, number>();
  prices.forEach((p, i) => dateToIndex.set(p.date, i));
  return {
    dateToIndex,
    rollingAvgAt: (index: number) => {
      const windowStart = Math.max(0, index + 1 - TURNOVER_LOOKBACK_DAYS);
      const n = index + 1 - windowStart;
      return (prefix[index + 1] - prefix[windowStart]) / n;
    },
  };
}

/** B'(유동성 필터) 벤치마크 — lib/benchmarkSummary.ts의 simulateUniverseMonthlyRebalance와
 * 동일한 알고리즘(가치 드리프트, 월 1회 재조정, 회전율 기반 비용 반영)이지만, 매
 * 리밸런싱마다 목표 유니버스를 "그날 시세가 있는 종목" 전체가 아니라 "그날 직전
 * 20거래일 평균 거래대금이 minTurnoverWon 이상인 종목"으로 좁힌다. 운영 코드
 * (lib/benchmarkSummary.ts)를 건드리지 않기 위해 이 스크립트에서만 독립적으로
 * 재구현한다. */
function simulateLiquidityFilteredMonthlyRebalance(
  pricesByStock: Map<string, DailyPrice[]>,
  tradeDateCalendar: string[],
  periodStartDate: string,
  minTurnoverWon: number
): number[] {
  const datesInPeriod = tradeDateCalendar.filter((d) => d >= periodStartDate).slice().sort();
  if (datesInPeriod.length === 0) return [];

  const priceMapByStock = new Map<string, Map<string, number>>();
  const turnoverLookupByStock = new Map<string, TurnoverLookup>();
  for (const [code, prices] of pricesByStock) {
    const dateToClose = new Map<string, number>();
    for (const p of prices) dateToClose.set(p.date, p.close);
    priceMapByStock.set(code, dateToClose);
    turnoverLookupByStock.set(code, buildTurnoverLookup(prices));
  }

  const rebalanceDates = new Set<string>([datesInPeriod[0]]);
  for (let i = 1; i < datesInPeriod.length; i++) {
    if (datesInPeriod[i].slice(0, 7) !== datesInPeriod[i - 1].slice(0, 7)) rebalanceDates.add(datesInPeriod[i]);
  }

  function liquidUniverseOn(date: string): string[] {
    const universe: string[] = [];
    for (const [code, lookup] of turnoverLookupByStock) {
      const idx = lookup.dateToIndex.get(date);
      if (idx === undefined) continue;
      if (lookup.rollingAvgAt(idx) >= minTurnoverWon) universe.push(code);
    }
    return universe;
  }

  let values = new Map<string, number>();
  const dailyReturnsPct: number[] = [];

  function sumValues(m: Map<string, number>): number {
    let s = 0;
    for (const v of m.values()) s += v;
    return s;
  }

  for (let i = 0; i < datesInPeriod.length; i++) {
    const date = datesInPeriod[i];
    const prevDate = i > 0 ? datesInPeriod[i - 1] : null;

    const sumBefore = sumValues(values);
    if (prevDate && sumBefore > 0) {
      for (const [code, value] of values) {
        const priceMap = priceMapByStock.get(code);
        const prevClose = priceMap?.get(prevDate);
        const close = priceMap?.get(date);
        if (prevClose !== undefined && close !== undefined) values.set(code, value * (close / prevClose));
      }
    }
    const sumAfter = sumValues(values);
    const dayReturn = sumBefore > 0 ? sumAfter / sumBefore - 1 : 0;

    let costDrag = 0;
    if (rebalanceDates.has(date)) {
      const universeToday = liquidUniverseOn(date);
      if (universeToday.length > 0) {
        const currentSum = sumValues(values);
        const currentWeights = new Map<string, number>();
        if (currentSum > 0) for (const [code, value] of values) currentWeights.set(code, value / currentSum);

        const targetWeight = 1 / universeToday.length;
        const targetWeights = new Map<string, number>(universeToday.map((code) => [code, targetWeight]));

        const allCodes = new Set<string>([...currentWeights.keys(), ...targetWeights.keys()]);
        let turnoverSum = 0;
        for (const code of allCodes) turnoverSum += Math.abs((currentWeights.get(code) ?? 0) - (targetWeights.get(code) ?? 0));
        const cashBefore = 1 - sumValues(currentWeights);
        const cashTarget = 1 - sumValues(targetWeights);
        turnoverSum += Math.abs(cashBefore - cashTarget);
        const turnover = 0.5 * turnoverSum;

        const buyRate = computeEffectiveBuyPrice(1) - 1;
        const sellRate = 1 - computeEffectiveSellPrice(1, date, "KR");
        costDrag = turnover * (buyRate + sellRate);

        values = targetWeights;
      } else {
        values = new Map();
      }
    }

    dailyReturnsPct.push(((1 + dayReturn) * (1 - costDrag) - 1) * 100);
  }

  return dailyReturnsPct;
}

function reportBenchmark(label: string, dailyReturnsPct: number[]): void {
  const { totalReturnPct, mddPct } = computeCumulativeAndMdd(dailyReturnsPct);
  const cagrPct = computeCagrPct(totalReturnPct, PERIOD_START_DATE, TODAY);
  const calmarRatio = computeCalmarRatio(cagrPct, mddPct);
  console.log(`  [${label}] CAGR ${cagrPct.toFixed(2)}%, MDD ${mddPct.toFixed(2)}%, 칼마 ${calmarRatio.toFixed(2)} (비용 반영)`);
}

function countExtremeDays(pricesByStock: Map<string, DailyPrice[]>, codes: Set<string>): { extreme: number; total: number } {
  let extreme = 0;
  let total = 0;
  for (const code of codes) {
    const prices = pricesByStock.get(code);
    if (!prices) continue;
    for (let i = 1; i < prices.length; i++) {
      const prevClose = prices[i - 1].close;
      if (prevClose <= 0) continue;
      const retPct = ((prices[i].close - prevClose) / prevClose) * 100;
      if (Math.abs(retPct) > 30) extreme++;
      total++;
    }
  }
  return { extreme, total };
}

/** 종목별 "그 시점 보유 기간 전체 단순 수익률"(마지막 종가/첫 종가 - 1)로 상위
 * N개를 뽑아 제외했을 때 벤치마크가 얼마나 바뀌는지 본다(전략의 top5-exclude와
 * 같은 취지지만, 거래 단위가 아니라 매수-후-보유 단순 수익률 기준). */
function topExcludeCagrDelta(
  pricesByStock: Map<string, DailyPrice[]>,
  codes: Set<string>,
  tradeDateCalendar: string[],
  topN: number
): { excluded: string[]; cagrWith: number; cagrWithout: number } {
  const simpleReturns: { code: string; returnPct: number }[] = [];
  for (const code of codes) {
    const prices = pricesByStock.get(code);
    if (!prices || prices.length < 2) continue;
    const first = prices[0].close;
    const last = prices[prices.length - 1].close;
    if (first > 0) simpleReturns.push({ code, returnPct: (last / first - 1) * 100 });
  }
  simpleReturns.sort((a, b) => b.returnPct - a.returnPct);
  const excluded = simpleReturns.slice(0, topN).map((r) => r.code);
  const excludeSet = new Set(excluded);

  const withMap = new Map<string, DailyPrice[]>();
  const withoutMap = new Map<string, DailyPrice[]>();
  for (const code of codes) {
    const prices = pricesByStock.get(code);
    if (!prices) continue;
    withMap.set(code, prices);
    if (!excludeSet.has(code)) withoutMap.set(code, prices);
  }

  const seriesWith = simulateUniverseMonthlyRebalance(withMap, tradeDateCalendar, PERIOD_START_DATE);
  const seriesWithout = simulateUniverseMonthlyRebalance(withoutMap, tradeDateCalendar, PERIOD_START_DATE);
  const cagrWith = computeCagrPct(computeCumulativeAndMdd(seriesWith).totalReturnPct, PERIOD_START_DATE, TODAY);
  const cagrWithout = computeCagrPct(computeCumulativeAndMdd(seriesWithout).totalReturnPct, PERIOD_START_DATE, TODAY);
  return { excluded, cagrWith, cagrWithout };
}

async function runMaCrossBacktest(
  codes: string[],
  pricesByStock: Map<string, DailyPrice[]>
): Promise<{ totalTrades: number; winRate: number; cagrPct: number; mddPct: number; payoffRatio: number | null }> {
  const trades: BacktestTrade[] = [];
  const dailyReturns: DailyStockReturns = new Map();
  const contributions = new Map<string, StockContribution>();

  for (const code of codes) {
    const prices = pricesByStock.get(code);
    if (!prices || prices.length === 0) continue;
    const result = runBacktest(prices, { rule_type: "ma_cross", rule_params: FALLBACK_MA_CROSS_PARAMS }, PERIOD_START_DATE, undefined, undefined, {
      market: "KR",
    });
    if (result.insufficientData || result.trades.length === 0) continue;
    trades.push(...result.trades);
    accumulateStockDailyReturns(dailyReturns, contributions, code, prices, result.trades, PERIOD_START_DATE, "KR");
  }

  if (trades.length === 0) return { totalTrades: 0, winRate: 0, cagrPct: 0, mddPct: 0, payoffRatio: null };

  const aggregate = aggregateTrades(trades);
  const returnPctList = trades.map((t) => t.returnPct * 100);
  const winReturns = returnPctList.filter((v) => v > 0);
  const lossReturns = returnPctList.filter((v) => v <= 0);
  const avgWinPct = winReturns.length > 0 ? winReturns.reduce((s, v) => s + v, 0) / winReturns.length : null;
  const avgLossPct = lossReturns.length > 0 ? lossReturns.reduce((s, v) => s + v, 0) / lossReturns.length : null;
  const payoffRatio = avgWinPct !== null && avgLossPct !== null && avgLossPct !== 0 ? avgWinPct / Math.abs(avgLossPct) : null;

  const dailySeries = computeEqualWeightDailyReturns(dailyReturns);
  const { totalReturnPct, mddPct } = computeCumulativeAndMdd(dailySeries);
  const cagrPct = computeCagrPct(totalReturnPct, PERIOD_START_DATE, TODAY);

  return { totalTrades: trades.length, winRate: aggregate.winRate, cagrPct, mddPct, payoffRatio };
}

async function main(): Promise<void> {
  console.log(`유니버스 후보 비교 시작: ${new Date().toISOString()}`);

  console.log("\n--- 유니버스 구성 ---");
  const aPrimeCodes = await fetchAllStoredCodes();
  console.log(`A'(근사 전종목, 저장된 모든 종목): ${aPrimeCodes.size}개`);

  const discoveryYears = Array.from(
    { length: CURRENT_YEAR - STRATEGY_BACKTEST_WINDOW_START_YEAR + 1 },
    (_, i) => STRATEGY_BACKTEST_WINDOW_START_YEAR + i
  );
  const cCodes = new Set(await discoverCandidateStockCodes(discoveryYears, STOCK_DATA_CANDIDATE_MARKET_CAP_EOK));
  console.log(`C(현행, 사후 1조원 이력): ${cCodes.size}개`);
  const cNotInAPrime = Array.from(cCodes).filter((c) => !aPrimeCodes.has(c));
  console.log(`  (검증) C 중 A'에 없는 종목: ${cNotInAPrime.length}개 — 0이어야 C가 A'의 부분집합.`);

  console.log(`\n--- A' 종목 ${aPrimeCodes.size}개 가격 시계열 조회 (${PRICE_FETCH_START_DATE} ~ ${TODAY}) ---`);
  const pricesByStock = new Map<string, DailyPrice[]>();
  let completed = 0;
  const aPrimeList = Array.from(aPrimeCodes);
  await runWithConcurrency(aPrimeList, BATCH_CONCURRENCY, async (code) => {
    try {
      const rows = await getDailyPriceSeries(code, PRICE_FETCH_START_DATE, TODAY);
      if (rows.length > 0) pricesByStock.set(code, rows.map(toDailyPrice));
    } catch (error) {
      console.error(`  ${code} 가격 조회 실패: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      completed++;
      if (completed === 1 || completed % 100 === 0 || completed === aPrimeList.length) {
        console.log(`  [${completed}/${aPrimeList.length}] 조회 중...`);
      }
    }
  });
  console.log(`가격 조회 완료: ${pricesByStock.size}개 종목에 데이터 있음`);

  const kospiSeries = await getIndexPriceSeries("KOSPI", PERIOD_START_DATE, TODAY);
  const tradeDateCalendar = kospiSeries.map((p) => p.tradeDate);

  // --- 월별 편입 종목 수 스냅샷 ---
  console.log("\n=== 월별 편입 종목 수 스냅샷 ===");
  const turnoverLookupByCode = new Map<string, TurnoverLookup>();
  for (const [code, prices] of pricesByStock) turnoverLookupByCode.set(code, buildTurnoverLookup(prices));

  function nearestTradeDateOnOrAfter(ym: string): string | null {
    const target = `${ym}-01`;
    return tradeDateCalendar.filter((d) => d >= target).sort()[0] ?? null;
  }

  for (const ym of SNAPSHOT_MONTHS) {
    const date = nearestTradeDateOnOrAfter(ym);
    if (!date) {
      console.log(`  ${ym}: 거래일 캘린더 범위 밖`);
      continue;
    }
    let aCount = 0;
    let cCount = 0;
    const bCounts = LIQUIDITY_THRESHOLDS_WON.map(() => 0);
    for (const [code, lookup] of turnoverLookupByCode) {
      const idx = lookup.dateToIndex.get(date);
      if (idx === undefined) continue;
      aCount++;
      if (cCodes.has(code)) cCount++;
      const avgTurnover = lookup.rollingAvgAt(idx);
      LIQUIDITY_THRESHOLDS_WON.forEach((t, i) => {
        if (avgTurnover >= t.value) bCounts[i]++;
      });
    }
    console.log(
      `  ${date}: A' ${aCount}개, C ${cCount}개, ` +
        LIQUIDITY_THRESHOLDS_WON.map((t, i) => `B'@${t.label} ${bCounts[i]}개`).join(", ")
    );
  }

  // --- 벤치마크(유니버스 월간 리밸런싱) CAGR/MDD/칼마 ---
  console.log("\n=== 벤치마크(유니버스 동일가중 월간 리밸런싱, 비용 반영) ===");
  const cPricesByStock = new Map<string, DailyPrice[]>();
  for (const code of cCodes) {
    const p = pricesByStock.get(code);
    if (p) cPricesByStock.set(code, p);
  }
  reportBenchmark("C(현행, 사후 1조원)", simulateUniverseMonthlyRebalance(cPricesByStock, tradeDateCalendar, PERIOD_START_DATE));
  reportBenchmark("A'(근사 전종목)", simulateUniverseMonthlyRebalance(pricesByStock, tradeDateCalendar, PERIOD_START_DATE));
  for (const t of LIQUIDITY_THRESHOLDS_WON) {
    reportBenchmark(
      `B'@${t.label}`,
      simulateLiquidityFilteredMonthlyRebalance(pricesByStock, tradeDateCalendar, PERIOD_START_DATE, t.value)
    );
  }

  // --- 극단값 영향 ---
  console.log("\n=== 극단값 영향 (일별수익률 ±30% 초과 종목-일 수) ===");
  const extremeC = countExtremeDays(pricesByStock, cCodes);
  const extremeA = countExtremeDays(pricesByStock, aPrimeCodes);
  console.log(`  C: ${extremeC.extreme}건 / 전체 ${extremeC.total}종목-일 (${((extremeC.extreme / extremeC.total) * 100).toFixed(3)}%)`);
  console.log(`  A': ${extremeA.extreme}건 / 전체 ${extremeA.total}종목-일 (${((extremeA.extreme / extremeA.total) * 100).toFixed(3)}%)`);

  console.log("\n=== 상위 5/10개 종목 제외 시 벤치마크 CAGR 변화 ===");
  for (const [label, codes] of [
    ["C", cCodes] as const,
    ["A'", aPrimeCodes] as const,
  ]) {
    for (const topN of [5, 10]) {
      const { excluded, cagrWith, cagrWithout } = topExcludeCagrDelta(pricesByStock, codes, tradeDateCalendar, topN);
      console.log(
        `  [${label}] 상위${topN}개 제외: CAGR ${cagrWith.toFixed(2)}% → ${cagrWithout.toFixed(2)}% (Δ${(cagrWithout - cagrWith).toFixed(2)}%p), ` +
          `제외 종목: ${excluded.join(", ")}`
      );
    }
  }

  // --- ma_cross 전략 백테스트 (시간 제약상 5개 전략 중 ma_cross만 실행) ---
  console.log("\n=== ma_cross 전략 백테스트 (A'/C, 대표 파라미터 20/60, 비용 반영) — 시간 제약상 ma_cross만 실행 ===");
  const maCrossC = await runMaCrossBacktest(Array.from(cCodes), pricesByStock);
  console.log(
    `  [C] 거래 ${maCrossC.totalTrades}건, 승률 ${(maCrossC.winRate * 100).toFixed(1)}%, CAGR ${maCrossC.cagrPct.toFixed(2)}%, ` +
      `MDD ${maCrossC.mddPct.toFixed(2)}%, 손익비 ${maCrossC.payoffRatio !== null ? maCrossC.payoffRatio.toFixed(2) : "-"}`
  );
  const maCrossAPrime = await runMaCrossBacktest(aPrimeList, pricesByStock);
  console.log(
    `  [A'] 거래 ${maCrossAPrime.totalTrades}건, 승률 ${(maCrossAPrime.winRate * 100).toFixed(1)}%, CAGR ${maCrossAPrime.cagrPct.toFixed(2)}%, ` +
      `MDD ${maCrossAPrime.mddPct.toFixed(2)}%, 손익비 ${maCrossAPrime.payoffRatio !== null ? maCrossAPrime.payoffRatio.toFixed(2) : "-"}`
  );

  console.log("\n완료");
}

main().catch((error) => {
  console.error("유니버스 후보 비교 중 오류:", error);
  process.exit(1);
});
