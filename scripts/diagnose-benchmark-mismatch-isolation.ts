/**
 * [디스포저블 진단 스크립트, 1회성] 벤치마크(유니버스 동일가중 월간 리밸런싱)
 * CAGR/MDD 수치 불일치 조사(2026-09-29) — 조건 a~d 격리 실험.
 *
 * 조사 배경: 이전 조사(디스포저블 스크립트, 이미 삭제됨, PR #398/#399)에서
 * "CAGR 8.1% / MDD -49.4%"(비용 미반영, 종료일 2026-09-03)였는데, PR-2로 정식
 * 구현한 lib/benchmarkSummary.ts로 실제 배치를 돌린 결과는 "CAGR 10.8% /
 * MDD -46.7%"(비용 반영, 종료일 2026-09-28)로 나왔다. 비용 반영은 항상 수익을
 * 깎고 낙폭을 키워야 하는데 둘 다 개선된 게 이상해, 계산 방식 자체가 바뀐 건지
 * 확인한다.
 *
 * 방법: lib/benchmarkSummary.ts의 simulateUniverseMonthlyRebalance를 그대로
 * import해서 쓰지 않고(그 함수는 비용을 항상 반영해 토글이 없다), 알고리즘이
 * 완전히 동일하되 costEnabled 파라미터로 비용 드래그만 0으로 고정할 수 있는
 * 로컬 복사본(simulateUniverseMonthlyRebalanceLocal)을 여기 안에 둔다.
 * computeCumulativeAndMdd/computeCagrPct는 프로덕션 lib/strategyBacktestSummary.ts
 * 함수를 그대로 재사용한다(이건 벤치마크 전용 로직이 아니라 전략도 같이 쓰는
 * 공통 집계 함수라 격리 대상이 아니다).
 *
 * 4가지 조건:
 *   a) 비용 미반영 + 종료일 2026-09-03 (이전 조사와 동일 조건 — 8.1%/-49.4%와
 *      일치하는지가 핵심 판정 기준)
 *   b) 비용 미반영 + 종료일 최신(오늘)
 *   c) 비용 반영 + 종료일 2026-09-03
 *   d) 비용 반영 + 종료일 최신(= 현재 배치가 저장한 값과 일치해야 함)
 *
 * 부록: 코스피/코스닥 지수 2026-09-03 vs 2026-09-28(또는 최신) sanity check.
 *
 * DB에는 아무것도 쓰지 않는다(순수 조회+계산+콘솔 출력). 조사가 끝나면 이
 * 스크립트와 대응 워크플로를 정리 PR로 제거한다(scripts/diagnose-benchmark-
 * reference-implementation.ts는 재현성을 위해 남겨둔다 — 별개).
 *
 * 실행: tsx --conditions=react-server scripts/diagnose-benchmark-mismatch-isolation.ts
 * 필요 환경변수: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { discoverCandidateStockCodes, getDailyPriceSeries, type StockDailyPriceRow } from "@/lib/stockDailyPricesStorage";
import { getIndexPriceSeries } from "@/lib/betaPriceHistoryStorage";
import { STOCK_DATA_CANDIDATE_MARKET_CAP_EOK } from "@/lib/stockDataConfig";
import { STRATEGY_BACKTEST_WINDOW_START_YEAR } from "@/lib/strategyBacktestSummaryConfig";
import { computeCumulativeAndMdd, computeCagrPct } from "@/lib/strategyBacktestSummary";
import { computeEffectiveBuyPrice, computeEffectiveSellPrice } from "@/lib/transactionCost";
import type { DailyPrice } from "@/lib/backtest";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const CURRENT_YEAR = new Date().getUTCFullYear();
const TODAY = new Date().toISOString().slice(0, 10);
const PERIOD_START_DATE = `${STRATEGY_BACKTEST_WINDOW_START_YEAR}-01-01`;
const PRICE_FETCH_START_DATE = "2014-01-01";
// 이전 조사가 사용한 종료일(당시 beta_price_history의 최신 날짜) — PR-1
// (getIndexPriceSeries 1000행 페이지네이션 버그 수정) 커밋 메시지에 명시된 값.
const OLD_INVESTIGATION_END_DATE = "2026-09-03";

const BATCH_CONCURRENCY = 10;

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

function sumValues(values: Map<string, number>): number {
  let sum = 0;
  for (const v of values.values()) sum += v;
  return sum;
}

/**
 * lib/benchmarkSummary.ts의 simulateUniverseMonthlyRebalance와 알고리즘이
 * 완전히 동일한 로컬 복사본 — 유일한 차이는 costEnabled=false일 때 costDrag를
 * 0으로 고정하는 것뿐이다(프로덕션 함수엔 비용 토글이 없어 조사 목적상 여기서만
 * 하나 둔다). 프로덕션 파일(lib/benchmarkSummary.ts)은 수정하지 않는다.
 */
function simulateUniverseMonthlyRebalanceLocal(
  pricesByStock: Map<string, DailyPrice[]>,
  tradeDateCalendar: string[],
  periodStartDate: string,
  costEnabled: boolean
): number[] {
  const datesInPeriod = tradeDateCalendar.filter((d) => d >= periodStartDate).slice().sort();
  if (datesInPeriod.length === 0) return [];

  const priceMapByStock = new Map<string, Map<string, number>>();
  for (const [code, prices] of pricesByStock) {
    const dateToClose = new Map<string, number>();
    for (const p of prices) dateToClose.set(p.date, p.close);
    priceMapByStock.set(code, dateToClose);
  }

  const rebalanceDates = new Set<string>([datesInPeriod[0]]);
  for (let i = 1; i < datesInPeriod.length; i++) {
    if (datesInPeriod[i].slice(0, 7) !== datesInPeriod[i - 1].slice(0, 7)) {
      rebalanceDates.add(datesInPeriod[i]);
    }
  }

  let values = new Map<string, number>();
  const dailyReturnsPct: number[] = [];

  for (let i = 0; i < datesInPeriod.length; i++) {
    const date = datesInPeriod[i];
    const prevDate = i > 0 ? datesInPeriod[i - 1] : null;

    const sumBefore = sumValues(values);
    if (prevDate && sumBefore > 0) {
      for (const [code, value] of values) {
        const priceMap = priceMapByStock.get(code);
        const prevClose = priceMap?.get(prevDate);
        const close = priceMap?.get(date);
        if (prevClose !== undefined && close !== undefined) {
          values.set(code, value * (close / prevClose));
        }
      }
    }
    const sumAfter = sumValues(values);
    const dayReturn = sumBefore > 0 ? sumAfter / sumBefore - 1 : 0;

    let costDrag = 0;
    if (rebalanceDates.has(date)) {
      const universeToday: string[] = [];
      for (const [code, priceMap] of priceMapByStock) {
        if (priceMap.has(date)) universeToday.push(code);
      }

      if (universeToday.length > 0) {
        const currentSum = sumValues(values);
        const currentWeights = new Map<string, number>();
        if (currentSum > 0) {
          for (const [code, value] of values) currentWeights.set(code, value / currentSum);
        }

        const targetWeight = 1 / universeToday.length;
        const targetWeights = new Map<string, number>(universeToday.map((code) => [code, targetWeight]));

        if (costEnabled) {
          const allCodes = new Set<string>([...currentWeights.keys(), ...targetWeights.keys()]);
          let turnoverSum = 0;
          for (const code of allCodes) {
            turnoverSum += Math.abs((currentWeights.get(code) ?? 0) - (targetWeights.get(code) ?? 0));
          }
          const cashBefore = 1 - sumValues(currentWeights);
          const cashTarget = 1 - sumValues(targetWeights);
          turnoverSum += Math.abs(cashBefore - cashTarget);
          const turnover = 0.5 * turnoverSum;

          const buyRate = computeEffectiveBuyPrice(1) - 1;
          const sellRate = 1 - computeEffectiveSellPrice(1, date, "KR");
          costDrag = turnover * (buyRate + sellRate);
        }

        values = targetWeights;
      }
    }

    dailyReturnsPct.push(((1 + dayReturn) * (1 - costDrag) - 1) * 100);
  }

  return dailyReturnsPct;
}

interface ConditionResult {
  label: string;
  costEnabled: boolean;
  endDate: string;
  cagrPct: number;
  mddPct: number;
}

async function main(): Promise<void> {
  console.log(`벤치마크 불일치 격리 실험 시작: ${new Date().toISOString()}`);

  const discoveryYears = Array.from(
    { length: CURRENT_YEAR - STRATEGY_BACKTEST_WINDOW_START_YEAR + 1 },
    (_, i) => STRATEGY_BACKTEST_WINDOW_START_YEAR + i
  );
  const universe = await discoverCandidateStockCodes(discoveryYears, STOCK_DATA_CANDIDATE_MARKET_CAP_EOK);
  console.log(`유니버스: ${universe.length}개 종목`);

  const pricesByStock = new Map<string, DailyPrice[]>();
  let completed = 0;
  await runWithConcurrency(universe, BATCH_CONCURRENCY, async (stockCode) => {
    try {
      const priceRows = await getDailyPriceSeries(stockCode, PRICE_FETCH_START_DATE, TODAY);
      if (priceRows.length === 0) return;
      pricesByStock.set(stockCode, priceRows.map(toDailyPrice));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  ${stockCode} 가격 조회 실패, 건너뜁니다: ${message}`);
    } finally {
      completed++;
      if (completed === 1 || completed % 100 === 0 || completed === universe.length) {
        console.log(`  [${completed}/${universe.length}] 종목 가격 조회 중...`);
      }
    }
  });

  const [kospiSeries, kosdaqSeries] = await Promise.all([
    getIndexPriceSeries("KOSPI", PERIOD_START_DATE, TODAY),
    getIndexPriceSeries("KOSDAQ", PERIOD_START_DATE, TODAY),
  ]);
  const fullCalendar = kospiSeries.map((p) => p.tradeDate);
  const oldCalendar = fullCalendar.filter((d) => d <= OLD_INVESTIGATION_END_DATE);
  console.log(
    `거래일 캘린더: 전체 ${fullCalendar.length}일(${fullCalendar[0]}~${fullCalendar[fullCalendar.length - 1]}), ` +
      `${OLD_INVESTIGATION_END_DATE}까지 ${oldCalendar.length}일`
  );

  const conditions: { label: string; costEnabled: boolean; calendar: string[]; endDate: string }[] = [
    { label: "a) 비용 미반영 + 종료일 2026-09-03", costEnabled: false, calendar: oldCalendar, endDate: OLD_INVESTIGATION_END_DATE },
    { label: "b) 비용 미반영 + 종료일 최신", costEnabled: false, calendar: fullCalendar, endDate: TODAY },
    { label: "c) 비용 반영 + 종료일 2026-09-03", costEnabled: true, calendar: oldCalendar, endDate: OLD_INVESTIGATION_END_DATE },
    { label: "d) 비용 반영 + 종료일 최신(현재 배치와 동일해야 함)", costEnabled: true, calendar: fullCalendar, endDate: TODAY },
  ];

  const results: ConditionResult[] = [];
  for (const cond of conditions) {
    const dailyReturnsPct = simulateUniverseMonthlyRebalanceLocal(pricesByStock, cond.calendar, PERIOD_START_DATE, cond.costEnabled);
    const { totalReturnPct, mddPct } = computeCumulativeAndMdd(dailyReturnsPct);
    const cagrPct = computeCagrPct(totalReturnPct, PERIOD_START_DATE, cond.endDate);
    results.push({ label: cond.label, costEnabled: cond.costEnabled, endDate: cond.endDate, cagrPct, mddPct });
  }

  console.log("\n=== 1) 격리 실험 결과(a~d) ===");
  for (const r of results) {
    console.log(`  [${r.label}] CAGR ${r.cagrPct.toFixed(2)}%, MDD ${r.mddPct.toFixed(2)}%`);
  }

  console.log("\n참고: 이전 조사 보고값 = CAGR 8.1% / MDD -49.4% (비용 미반영, 종료일 2026-09-03)");
  console.log("참고: 현재 배치 저장값(사용자 보고) = CAGR 10.8% / MDD -46.7% (비용 반영, 종료일 2026-09-28)");

  const { data: latestBenchmarkRow, error: benchmarkError } = await supabaseAdmin
    .from("benchmark_summary")
    .select("period_end_date, cagr_pct, mdd_pct, cost_included")
    .eq("benchmark_type", "universe_monthly_rebalance")
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (benchmarkError) {
    console.error(`benchmark_summary 최신 행 조회 실패: ${benchmarkError.message}`);
  } else if (latestBenchmarkRow) {
    console.log(
      `\nDB에 실제 저장된 최신 universe_monthly_rebalance 행: 종료일 ${latestBenchmarkRow.period_end_date}, ` +
        `CAGR ${Number(latestBenchmarkRow.cagr_pct).toFixed(2)}%, MDD ${Number(latestBenchmarkRow.mdd_pct).toFixed(2)}%, ` +
        `cost_included=${latestBenchmarkRow.cost_included}`
    );
  }

  console.log("\n=== 4) 코스피/코스닥 sanity check (2026-09-03 vs 최신) ===");
  function closeOnOrBefore(series: { tradeDate: string; closePrice: number }[], date: string): { tradeDate: string; closePrice: number } | null {
    let result: { tradeDate: string; closePrice: number } | null = null;
    for (const p of series) {
      if (p.tradeDate <= date) result = p;
      else break;
    }
    return result;
  }
  for (const [label, series] of [
    ["코스피", kospiSeries],
    ["코스닥", kosdaqSeries],
  ] as const) {
    const oldPoint = closeOnOrBefore(series, OLD_INVESTIGATION_END_DATE);
    const newPoint = series[series.length - 1];
    if (!oldPoint || !newPoint) {
      console.log(`  [${label}] 데이터 부족`);
      continue;
    }
    const changePct = (newPoint.closePrice / oldPoint.closePrice - 1) * 100;
    console.log(
      `  [${label}] ${oldPoint.tradeDate} 종가 ${oldPoint.closePrice.toFixed(2)} → ${newPoint.tradeDate} 종가 ` +
        `${newPoint.closePrice.toFixed(2)} (${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%)`
    );
  }

  console.log("\n완료");
}

main().catch((error) => {
  console.error("격리 실험 중 오류:", error);
  process.exit(1);
});
