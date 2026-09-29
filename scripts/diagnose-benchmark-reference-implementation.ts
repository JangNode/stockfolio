/**
 * [독립 참조 구현, 영구 보존] "장기 백테스트" 카드의 유니버스 동일가중 월간
 * 리밸런싱 벤치마크(lib/benchmarkSummary.ts의 simulateUniverseMonthlyRebalance,
 * PR-2 #402)를 재현·교차검증하기 위한 완전히 독립적인 참조 구현.
 *
 * 2026-09-29 벤치마크 CAGR/MDD 수치 불일치 조사(이전 디스포저블 조사값
 * "CAGR 8.1% / MDD -49.4%(비용 미반영, 종료일 2026-09-03)" vs PR-2 정식 배치값
 * "CAGR 10.8% / MDD -46.7%(비용 반영, 종료일 2026-09-28)")의 일부로 작성됐다.
 * 이 스크립트는 RULES.md 11번의 "워크스트림 종료 시 디스포저블 스크립트 자동
 * 정리" 예외다 — 조사가 끝나도 삭제하지 않고 재현 가능성을 위해 남겨둔다(사용자
 * 요청, 2026-09-29). DB에는 아무것도 쓰지 않는다(순수 조회+계산+콘솔 출력).
 *
 * lib/benchmarkSummary.ts/lib/strategyBacktestSummary.ts/lib/transactionCost.ts의
 * 계산 함수를 재사용하지 않고, 원자료(stock_daily_prices_recent/Parquet,
 * beta_price_history)에서 직접 세 가지 방식으로 유니버스 월간 리밸런싱
 * CAGR/MDD를 계산해 비교한다(원자료 접근 함수인 getDailyPriceSeries/
 * discoverCandidateStockCodes/getIndexPriceSeries만 재사용 — 이건 DB 조회 배관일
 * 뿐 벤치마크 계산 로직이 아니다):
 *
 *   방식 A "일별 동일가중 평균(결측 0%로 채움)": 매월 첫 거래일에 point-in-time
 *     유니버스(그날 시세 있는 종목)를 고정하고, 그 이후 매일 "그날 보유 중인
 *     모든 종목의 종가 대비 종가 수익률"을 단순 평균한다. 시세가 없는 종목
 *     (상장폐지 등)은 그날 수익률을 0%로 채워 분모(멤버 수)에 그대로 포함시킨다
 *     — "상장폐지 종목을 마지막 가격에서 동결"과 수학적으로 동치(그 종목
 *     기여분이 0%로 유지되다가 다음 리밸런싱에서 자연히 빠짐).
 *   방식 B "일별 동일가중 평균(결측 제외)": A와 같지만, 시세가 없는 종목은
 *     그날 분모에서 제외하고 나머지끼리 평균한다 — 상장폐지 종목은 마지막
 *     거래일 다음날부터 즉시 계산에서 빠진다(동결이 아니라 제외).
 *   방식 C "가치 드리프트(리밸런싱 월 1회)": lib/benchmarkSummary.ts가 실제로
 *     쓰는 방식과 같은 알고리즘 — 리밸런싱 시 동일가중으로 맞춘 뒤, 그 사이엔
 *     각 종목 "보유 가치"가 개별 가격변동만큼 매일 드리프트한다(리밸런싱 사이
 *     기간엔 재조정 없이 자연히 비중이 변함 — 진짜 "매수 후 보유, 월 1회만
 *     재조정"). 시세 없는 종목은 값이 동결된다. 거래비용(회전율 기반)을 반영한
 *     버전(C-cost)도 별도로 계산한다.
 *
 * 코드 읽고 확인한 결과: lib/benchmarkSummary.ts의 simulateUniverseMonthlyRebalance는
 * 방식 C(가치 드리프트, 월 1회 재조정 + 비용 반영)를 구현한다 — "매일 동일가중
 * 재평균"이 아니라 "월초에만 동일가중으로 맞추고 그 사이엔 자연 드리프트"다.
 * 아래 결과표에서 방식 C-cost가 실제 DB 저장값(benchmark_summary)과 거의
 * 일치하는지로 이 코드 판단을 실측 검증한다.
 *
 * 실행: tsx --conditions=react-server scripts/diagnose-benchmark-reference-implementation.ts
 * 필요 환경변수: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { discoverCandidateStockCodes, getDailyPriceSeries, type StockDailyPriceRow } from "@/lib/stockDailyPricesStorage";
import { getIndexPriceSeries } from "@/lib/betaPriceHistoryStorage";
import { STOCK_DATA_CANDIDATE_MARKET_CAP_EOK } from "@/lib/stockDataConfig";
import { STRATEGY_BACKTEST_WINDOW_START_YEAR } from "@/lib/strategyBacktestSummaryConfig";
import { FEE_PCT_PER_SIDE, SLIPPAGE_PCT_PER_SIDE, SECURITIES_TAX_RATE_SCHEDULE } from "@/lib/transactionCostConfig";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const CURRENT_YEAR = new Date().getUTCFullYear();
const TODAY = new Date().toISOString().slice(0, 10);
const PERIOD_START_DATE = `${STRATEGY_BACKTEST_WINDOW_START_YEAR}-01-01`;
const PRICE_FETCH_START_DATE = "2014-01-01";
const BATCH_CONCURRENCY = 10;
const DAYS_PER_YEAR = 365.25; // lib/strategyBacktestSummary.ts computeCagrPct와 동일한 그레고리력 평균 연 길이(독립적으로 재정의).

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

/** lib/strategyBacktestSummary.ts의 computeCumulativeAndMdd를 재사용하지 않고
 * 독립적으로 재구현한 복리 누적+MDD 계산(100에서 시작, 동일한 수식). */
function cumulativeAndMdd(dailyReturnsPct: number[]): { totalReturnPct: number; mddPct: number } {
  let index = 100;
  let peak = 100;
  let mdd = 0;
  for (const r of dailyReturnsPct) {
    index *= 1 + r / 100;
    if (index > peak) peak = index;
    const dd = ((peak - index) / peak) * 100;
    if (dd > mdd) mdd = dd;
  }
  return { totalReturnPct: index - 100, mddPct: mdd };
}

/** lib/strategyBacktestSummary.ts의 computeCagrPct를 재사용하지 않고 독립적으로
 * 재구현한 CAGR 연환산(동일한 수식). */
function cagrPct(totalReturnPct: number, startDate: string, endDate: string): number {
  const start = new Date(startDate + "T00:00:00Z").getTime();
  const end = new Date(endDate + "T00:00:00Z").getTime();
  const periodDays = (end - start) / (1000 * 60 * 60 * 24);
  if (periodDays <= 0) return 0;
  const multiplier = 1 + totalReturnPct / 100;
  if (multiplier <= 0) return -100;
  return (Math.pow(multiplier, DAYS_PER_YEAR / periodDays) - 1) * 100;
}

/** lib/transactionCost.ts를 재사용하지 않고 독립적으로 재구현한 매수/매도 비용률
 * (설정값 자체(FEE_PCT_PER_SIDE 등)는 RULES.md 2번에 따라 lib/transactionCostConfig.ts
 * 하나에만 있는 출처를 그대로 가져다 쓴다 — 매직넘버를 여기 새로 박지 않는다). */
function securitiesTaxRate(dateStr: string): number {
  let rate = SECURITIES_TAX_RATE_SCHEDULE[0].ratePct;
  for (const step of SECURITIES_TAX_RATE_SCHEDULE) {
    if (step.effectiveFrom <= dateStr) rate = step.ratePct;
    else break;
  }
  return rate;
}
function buyCostRate(): number {
  return (1 + SLIPPAGE_PCT_PER_SIDE) * (1 + FEE_PCT_PER_SIDE) - 1;
}
function sellCostRate(dateStr: string): number {
  return 1 - (1 - SLIPPAGE_PCT_PER_SIDE) * (1 - FEE_PCT_PER_SIDE - securitiesTaxRate(dateStr));
}

function toDailyPrice(row: StockDailyPriceRow): { date: string; close: number } {
  return { date: row.tradeDate, close: row.closePrice };
}

interface StockPriceInfo {
  byDate: Map<string, number>;
}

function firstDayOfMonthDates(dates: string[]): Set<string> {
  const seen = new Set<string>();
  const result = new Set<string>();
  for (const d of dates) {
    const ym = d.slice(0, 7);
    if (!seen.has(ym)) {
      seen.add(ym);
      result.add(d);
    }
  }
  return result;
}

/** 방식 A/B 공용: 매월 첫 거래일에 point-in-time 유니버스를 고정하고, 매일
 * "그날 보유 중인 멤버들의 종가 대비 종가 수익률"을 동일가중 평균한다.
 * fillMissingWithZero=true면 결측 종목을 0%로 채워 분모에 포함(A),
 * false면 결측 종목을 그날 분모에서 제외(B). */
function dailyEqualWeightAverage(
  stockPriceInfos: Map<string, StockPriceInfo>,
  masterDates: string[],
  rebalanceDates: Set<string>,
  fillMissingWithZero: boolean
): number[] {
  let membership: string[] = [];
  const dailyReturnsPct: number[] = [];

  for (let i = 0; i < masterDates.length; i++) {
    const date = masterDates[i];
    const prevDate = i > 0 ? masterDates[i - 1] : null;

    if (rebalanceDates.has(date)) {
      membership = [];
      for (const [code, info] of stockPriceInfos) {
        if (info.byDate.has(date)) membership.push(code);
      }
      // 리밸런싱 당일은 방금 새 바스켓을 구성한 시점이라 수익률 0%(프로덕션
      // lib/benchmarkSummary.ts의 리밸런싱 당일 값 교체 시점과 동일 관례).
      dailyReturnsPct.push(0);
      continue;
    }

    if (membership.length === 0 || prevDate === null) {
      dailyReturnsPct.push(0);
      continue;
    }

    let sum = 0;
    let n = 0;
    for (const code of membership) {
      const info = stockPriceInfos.get(code)!;
      const prevClose = info.byDate.get(prevDate);
      const close = info.byDate.get(date);
      if (prevClose !== undefined && close !== undefined) {
        sum += (close / prevClose - 1) * 100;
        n++;
      } else if (fillMissingWithZero) {
        n++; // 0% 기여로 분모에 포함
      }
      // fillMissingWithZero=false면 분모/분자 둘 다에서 아예 제외
    }
    dailyReturnsPct.push(n > 0 ? sum / n : 0);
  }

  return dailyReturnsPct;
}

/** 방식 C: 가치 드리프트(월 1회만 동일가중으로 재조정, 그 사이엔 자연 드리프트).
 * applyCost=true면 리밸런싱마다 회전율 기반 비용 드래그를 반영한다(방식 C-cost).
 * lib/benchmarkSummary.ts의 simulateUniverseMonthlyRebalance와 같은 알고리즘을
 * 독립적으로 재구현한 것 — import는 하지 않는다. */
function valueDriftMonthlyRebalance(
  stockPriceInfos: Map<string, StockPriceInfo>,
  masterDates: string[],
  rebalanceDates: Set<string>,
  applyCost: boolean
): number[] {
  let values = new Map<string, number>();
  const dailyReturnsPct: number[] = [];

  function sumOf(m: Map<string, number>): number {
    let s = 0;
    for (const v of m.values()) s += v;
    return s;
  }

  for (let i = 0; i < masterDates.length; i++) {
    const date = masterDates[i];
    const prevDate = i > 0 ? masterDates[i - 1] : null;

    const sumBefore = sumOf(values);
    if (prevDate && sumBefore > 0) {
      for (const [code, value] of values) {
        const info = stockPriceInfos.get(code);
        const prevClose = info?.byDate.get(prevDate);
        const close = info?.byDate.get(date);
        if (prevClose !== undefined && close !== undefined) {
          values.set(code, value * (close / prevClose));
        }
      }
    }
    const sumAfter = sumOf(values);
    const dayReturn = sumBefore > 0 ? sumAfter / sumBefore - 1 : 0;

    let costDrag = 0;
    if (rebalanceDates.has(date)) {
      const universeToday: string[] = [];
      for (const [code, info] of stockPriceInfos) {
        if (info.byDate.has(date)) universeToday.push(code);
      }
      if (universeToday.length > 0) {
        const currentSum = sumOf(values);
        const currentWeights = new Map<string, number>();
        if (currentSum > 0) {
          for (const [code, value] of values) currentWeights.set(code, value / currentSum);
        }
        const targetWeight = 1 / universeToday.length;
        const targetWeights = new Map<string, number>(universeToday.map((code) => [code, targetWeight]));

        if (applyCost) {
          const allCodes = new Set<string>([...currentWeights.keys(), ...targetWeights.keys()]);
          let turnoverSum = 0;
          for (const code of allCodes) {
            turnoverSum += Math.abs((currentWeights.get(code) ?? 0) - (targetWeights.get(code) ?? 0));
          }
          const cashBefore = 1 - sumOf(currentWeights);
          const cashTarget = 1 - sumOf(targetWeights);
          turnoverSum += Math.abs(cashBefore - cashTarget);
          const turnover = 0.5 * turnoverSum;
          costDrag = turnover * (buyCostRate() + sellCostRate(date));
        }

        values = targetWeights;
      }
    }

    dailyReturnsPct.push(((1 + dayReturn) * (1 - costDrag) - 1) * 100);
  }

  return dailyReturnsPct;
}

async function main(): Promise<void> {
  console.log(`벤치마크 참조 구현 실행 시작: ${new Date().toISOString()}`);

  const discoveryYears = Array.from(
    { length: CURRENT_YEAR - STRATEGY_BACKTEST_WINDOW_START_YEAR + 1 },
    (_, i) => STRATEGY_BACKTEST_WINDOW_START_YEAR + i
  );
  const universe = await discoverCandidateStockCodes(discoveryYears, STOCK_DATA_CANDIDATE_MARKET_CAP_EOK);
  console.log(`유니버스: ${universe.length}개 종목`);

  const stockPriceInfos = new Map<string, StockPriceInfo>();
  let completed = 0;
  await runWithConcurrency(universe, BATCH_CONCURRENCY, async (stockCode) => {
    try {
      const priceRows = await getDailyPriceSeries(stockCode, PRICE_FETCH_START_DATE, TODAY);
      if (priceRows.length === 0) return;
      const byDate = new Map<string, number>();
      for (const row of priceRows.map(toDailyPrice)) byDate.set(row.date, row.close);
      stockPriceInfos.set(stockCode, { byDate });
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

  const kospiSeries = await getIndexPriceSeries("KOSPI", PERIOD_START_DATE, TODAY);
  const masterDates = kospiSeries.map((p) => p.tradeDate).filter((d) => d >= PERIOD_START_DATE);
  const rebalanceDates = firstDayOfMonthDates(masterDates);
  console.log(`거래일 캘린더: ${masterDates.length}일 (${masterDates[0]} ~ ${masterDates[masterDates.length - 1]})`);

  const methodA = dailyEqualWeightAverage(stockPriceInfos, masterDates, rebalanceDates, true);
  const methodB = dailyEqualWeightAverage(stockPriceInfos, masterDates, rebalanceDates, false);
  const methodC = valueDriftMonthlyRebalance(stockPriceInfos, masterDates, rebalanceDates, false);
  const methodCCost = valueDriftMonthlyRebalance(stockPriceInfos, masterDates, rebalanceDates, true);

  const endDate = masterDates[masterDates.length - 1];
  const rows: { label: string; series: number[] }[] = [
    { label: "A) 일별 동일가중 평균(결측 0%로 채움 ≈ 상폐 동결)", series: methodA },
    { label: "B) 일별 동일가중 평균(결측 제외 ≈ 상폐 즉시 제외)", series: methodB },
    { label: "C) 가치 드리프트, 월 1회 재조정(비용 미반영)", series: methodC },
    { label: "C-cost) 가치 드리프트, 월 1회 재조정(비용 반영, 프로덕션과 동일 알고리즘)", series: methodCCost },
  ];

  console.log("\n=== 2) 참조 구현 결과(4가지 방식) ===");
  for (const row of rows) {
    const { totalReturnPct, mddPct } = cumulativeAndMdd(row.series);
    const cagr = cagrPct(totalReturnPct, PERIOD_START_DATE, endDate);
    console.log(`  [${row.label}] CAGR ${cagr.toFixed(2)}%, MDD ${mddPct.toFixed(2)}% (종료일 ${endDate})`);
  }

  const { data: latestBenchmarkRow, error: benchmarkError } = await supabaseAdmin
    .from("benchmark_summary")
    .select("period_end_date, cagr_pct, mdd_pct, cost_included")
    .eq("benchmark_type", "universe_monthly_rebalance")
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (benchmarkError) {
    console.error(`\nbenchmark_summary 최신 행 조회 실패: ${benchmarkError.message}`);
  } else if (latestBenchmarkRow) {
    console.log(
      `\n프로덕션 DB 저장값(benchmark_summary, universe_monthly_rebalance 최신 행): 종료일 ` +
        `${latestBenchmarkRow.period_end_date}, CAGR ${Number(latestBenchmarkRow.cagr_pct).toFixed(2)}%, ` +
        `MDD ${Number(latestBenchmarkRow.mdd_pct).toFixed(2)}%, cost_included=${latestBenchmarkRow.cost_included}`
    );
    console.log(
      "→ 위 C-cost 결과와 비교: 종료일이 같고 CAGR/MDD가 거의 일치하면(약간의 차이는 스크립트 실행 시점 데이터 갱신 때문일 수 있음) " +
        "lib/benchmarkSummary.ts가 '방식 C(가치 드리프트, 월 1회 재조정)+비용 반영'을 구현한다는 코드 판단이 실측으로 확인된 것이다."
    );
  }

  console.log("\n완료");
}

main().catch((error) => {
  console.error("참조 구현 실행 중 오류:", error);
  process.exit(1);
});
