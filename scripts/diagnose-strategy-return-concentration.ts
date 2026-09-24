/**
 * [디스포저블 진단 스크립트] 포트폴리오 MDD 분석 — diagnose-strategy-daily-returns.ts
 * 결과(reversal_breakout/v2의 비정상적으로 큰 누적수익률·MDD, ma_cross/minervini의
 * 0.811 상관, reversal_breakout/peg_lynch의 0.04 상관)가 실제 분산효과/구조적 특성인지,
 * 소수 종목 쏠림이나 활성일 안 겹침 같은 착시인지 확인한다. DB/Storage 쓰기 없음
 * (순수 조회+계산).
 *
 * diagnose-strategy-daily-returns.ts와 동일한 유니버스/기간/rule_params를 그대로
 * 재사용하되(2026-09-24 실행분과 동일 조건), 이번엔 종목별 기여도와 날짜별 종목 목록도
 * 함께 추적한다:
 *
 * 1. reversal_breakout/reversal_breakout_v2: 종목별 누적 기여도 상위 8개를 뽑아 제외한
 *    뒤 포트폴리오를 다시 계산해, 수익률/MDD가 소수 종목에 얼마나 좌우되는지 확인한다.
 * 2. 전략별 최대 낙폭(MDD) 구간(고점일~저점일)을 찾고, 그 구간에 실제로 보유 중이던
 *    종목들의 개별 기여도(reversal_breakout류) 및 코스피/코스닥 지수 변화(시장 전체
 *    조정 여부)를 함께 확인한다.
 * 3. reversal_breakout(v1/v2)와 peg_lynch가 둘 다 활성 상태인 날(활성일 교집합)만 골라
 *    상관계수를 다시 계산해, 전체 기간 기준 0.04가 진짜 분산효과인지 활성일이 안 겹쳐서
 *    생긴 착시인지 구분한다.
 * 4. ma_cross/minervini는 활성일이 거의 항상 겹치므로(둘 다 ~100% 활성), 연도별
 *    상관계수와 일별 수익률 부호 일치율을 따로 계산해 0.811이 특정 시기에 쏠린 결과인지
 *    구조적으로 항상 그런지 확인한다.
 *
 * 필요 환경변수: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   tsx --conditions=react-server scripts/diagnose-strategy-return-concentration.ts
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  discoverCandidateStockCodes,
  getDailyPriceSeries,
  type StockDailyPriceRow,
} from "@/lib/stockDailyPricesStorage";
import { loadFundamentalsSeriesWithListedShares, type FundamentalsSeries } from "@/lib/stockFundamentals";
import { getIndexPriceSeries } from "@/lib/betaPriceHistoryStorage";
import { runBacktest, type StrategyRule, type DailyPrice, type MaCrossParams, type MinerviniParams } from "@/lib/backtest";
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

const FALLBACK_MA_CROSS_PARAMS: MaCrossParams = { short_period: 20, long_period: 60 };
const FALLBACK_MINERVINI_PARAMS: MinerviniParams = { ma_short: 50, ma_mid: 150, ma_long: 200 };

const TARGET_RULE_TYPES = [
  "ma_cross",
  "minervini_trend_template",
  "reversal_breakout",
  "reversal_breakout_v2",
  "peg_lynch",
] as const;
type TargetRuleType = (typeof TARGET_RULE_TYPES)[number];

// 종목×날짜 기여도를 상세히 남기는 전략만(용량 절감 — ma_cross/minervini는 거의
// 항상 다수 종목이 동시 활성 상태라 전부 남기면 메모리 부담이 크고, 이번 분석엔
// 필요하지도 않다).
const DETAIL_TRACKED_RULE_TYPES = ["reversal_breakout", "reversal_breakout_v2"] as const;
type DetailTrackedRuleType = (typeof DETAIL_TRACKED_RULE_TYPES)[number];

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

async function loadActiveRuleParams(
  ruleType: "ma_cross" | "minervini_trend_template"
): Promise<Record<string, unknown> | null> {
  const { data, error } = await supabaseAdmin
    .from("strategies")
    .select("rule_params")
    .eq("rule_type", ruleType)
    .eq("market", "KR")
    .limit(1);
  if (error) throw new Error(`${ruleType} 활성 전략 조회 실패: ${error.message}`);
  return data && data.length > 0 ? (data[0].rule_params as Record<string, unknown>) : null;
}

function pearsonCorrelation(a: number[], b: number[]): number {
  const n = a.length;
  if (n === 0) return 0;
  const meanA = a.reduce((s, v) => s + v, 0) / n;
  const meanB = b.reduce((s, v) => s + v, 0) / n;
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  if (varA === 0 || varB === 0) return 0;
  return cov / Math.sqrt(varA * varB);
}

interface DrawdownWindow {
  peakDate: string;
  troughDate: string;
  peakIndex: number;
  troughIndex: number;
  mddPct: number;
}

/** 일별 수익률(%) 시계열에서 최대 낙폭 구간(고점 날짜~저점 날짜)을 찾는다. */
function findMaxDrawdownWindow(dates: string[], dailyReturnsPct: number[]): DrawdownWindow {
  let index = 100;
  let peak = 100;
  let peakDate = dates[0];
  let maxDd = 0;
  let ddPeakDate = dates[0];
  let ddTroughDate = dates[0];

  for (let i = 0; i < dailyReturnsPct.length; i++) {
    index *= 1 + dailyReturnsPct[i] / 100;
    if (index > peak) {
      peak = index;
      peakDate = dates[i];
    }
    const dd = ((peak - index) / peak) * 100;
    if (dd > maxDd) {
      maxDd = dd;
      ddPeakDate = peakDate;
      ddTroughDate = dates[i];
    }
  }

  return {
    peakDate: ddPeakDate,
    troughDate: ddTroughDate,
    peakIndex: dates.indexOf(ddPeakDate),
    troughIndex: dates.indexOf(ddTroughDate),
    mddPct: maxDd,
  };
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

async function main(): Promise<void> {
  console.log(`전략 수익률 쏠림/분산효과 진단 시작: ${new Date().toISOString()}`);

  const [maCrossActive, minerviniActive] = await Promise.all([
    loadActiveRuleParams("ma_cross"),
    loadActiveRuleParams("minervini_trend_template"),
  ]);
  const maCrossParams = (maCrossActive as unknown as MaCrossParams | null) ?? FALLBACK_MA_CROSS_PARAMS;
  const minerviniParams = (minerviniActive as unknown as MinerviniParams | null) ?? FALLBACK_MINERVINI_PARAMS;
  console.log(`ma_cross params: ${JSON.stringify(maCrossParams)}, minervini params: ${JSON.stringify(minerviniParams)}`);

  const RULES: Record<TargetRuleType, StrategyRule> = {
    ma_cross: { rule_type: "ma_cross", rule_params: maCrossParams },
    minervini_trend_template: { rule_type: "minervini_trend_template", rule_params: minerviniParams },
    reversal_breakout: { rule_type: "reversal_breakout", rule_params: {} },
    reversal_breakout_v2: { rule_type: "reversal_breakout_v2", rule_params: {} },
    peg_lynch: { rule_type: "peg_lynch", rule_params: {} },
  };

  const discoveryYears = Array.from(
    { length: CURRENT_YEAR - UNIVERSE_START_YEAR + 1 },
    (_, i) => UNIVERSE_START_YEAR + i
  );
  const universe = await discoverCandidateStockCodes(discoveryYears, STOCK_DATA_CANDIDATE_MARKET_CAP_EOK);
  console.log(`유니버스: ${universe.length}개 종목`);

  const allDates = new Set<string>();
  const dailyReturnSum: Record<TargetRuleType, Map<string, number>> = {
    ma_cross: new Map(),
    minervini_trend_template: new Map(),
    reversal_breakout: new Map(),
    reversal_breakout_v2: new Map(),
    peg_lynch: new Map(),
  };
  const dailyActiveCount: Record<TargetRuleType, Map<string, number>> = {
    ma_cross: new Map(),
    minervini_trend_template: new Map(),
    reversal_breakout: new Map(),
    reversal_breakout_v2: new Map(),
    peg_lynch: new Map(),
  };
  const perStockContribution: Record<TargetRuleType, Map<string, StockContribution>> = {
    ma_cross: new Map(),
    minervini_trend_template: new Map(),
    reversal_breakout: new Map(),
    reversal_breakout_v2: new Map(),
    peg_lynch: new Map(),
  };
  const perStockDateReturn: Record<DetailTrackedRuleType, Map<string, Array<{ code: string; ret: number }>>> = {
    reversal_breakout: new Map(),
    reversal_breakout_v2: new Map(),
  };

  function isDetailTracked(ruleType: TargetRuleType): ruleType is DetailTrackedRuleType {
    return (DETAIL_TRACKED_RULE_TYPES as readonly string[]).includes(ruleType);
  }

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
        // peg_lynch만 영향 — diagnose-strategy-daily-returns.ts와 동일하게 조용히 건너뛴다.
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

            if (isDetailTracked(ruleType)) {
              const arr = perStockDateReturn[ruleType].get(date) ?? [];
              arr.push({ code: stockCode, ret: dailyReturn });
              perStockDateReturn[ruleType].set(date, arr);
            }
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

  const seriesByRuleType: Record<TargetRuleType, number[]> = {} as Record<TargetRuleType, number[]>;
  for (const ruleType of TARGET_RULE_TYPES) {
    seriesByRuleType[ruleType] = avgSeries(ruleType);
  }

  // === 1. 상위 기여 종목 제외 후 재계산(reversal_breakout/v2) ===
  console.log("\n=== 1. 상위 기여 종목 제외 후 재계산 ===");
  for (const ruleType of DETAIL_TRACKED_RULE_TYPES) {
    const ranked = Array.from(perStockContribution[ruleType].entries())
      .map(([code, c]) => ({ code, ownReturnPct: (c.multiplier - 1) * 100, tradeCount: c.tradeCount, heldDays: c.heldDays }))
      .sort((a, b) => b.ownReturnPct - a.ownReturnPct);

    const top = ranked.slice(0, TOP_CONTRIBUTOR_EXCLUDE_COUNT);
    console.log(`\n[${ruleType}] 종목 자체 수익률 상위 ${TOP_CONTRIBUTOR_EXCLUDE_COUNT}개:`);
    for (const t of top) {
      console.log(
        `    ${t.code}: 자체수익률 ${t.ownReturnPct.toFixed(1)}%, 거래 ${t.tradeCount}건, 보유일 ${t.heldDays}일`
      );
    }

    const excludeSet = new Set(top.map((t) => t.code));
    const excludedSeries = sortedDates.map((d) => {
      const entries = (perStockDateReturn[ruleType].get(d) ?? []).filter((e) => !excludeSet.has(e.code));
      if (entries.length === 0) return 0;
      return (entries.reduce((s, e) => s + e.ret, 0) / entries.length) * 100;
    });

    const original = computeCumulativeAndMdd(seriesByRuleType[ruleType]);
    const excluded = computeCumulativeAndMdd(excludedSeries);
    console.log(
      `  [${ruleType}] 전체: 누적수익률 ${original.totalReturnPct.toFixed(1)}%, MDD ${original.mddPct.toFixed(1)}%`
    );
    console.log(
      `  [${ruleType}] 상위 ${TOP_CONTRIBUTOR_EXCLUDE_COUNT}개 제외: 누적수익률 ${excluded.totalReturnPct.toFixed(1)}%, MDD ${excluded.mddPct.toFixed(1)}%`
    );
  }

  // === 2. 최대 낙폭(MDD) 구간 확인 ===
  console.log("\n=== 2. 최대 낙폭(MDD) 구간 ===");
  const drawdownWindows: Record<TargetRuleType, DrawdownWindow> = {} as Record<TargetRuleType, DrawdownWindow>;
  for (const ruleType of TARGET_RULE_TYPES) {
    const dd = findMaxDrawdownWindow(sortedDates, seriesByRuleType[ruleType]);
    drawdownWindows[ruleType] = dd;
    console.log(`  [${ruleType}] 고점 ${dd.peakDate} → 저점 ${dd.troughDate}, MDD ${dd.mddPct.toFixed(1)}%`);
  }

  for (const ruleType of DETAIL_TRACKED_RULE_TYPES) {
    const dd = drawdownWindows[ruleType];
    const windowDates = sortedDates.slice(dd.peakIndex, dd.troughIndex + 1);
    const contributionByCode = new Map<string, number>();
    const distinctCodes = new Set<string>();
    for (const d of windowDates) {
      for (const entry of perStockDateReturn[ruleType].get(d) ?? []) {
        distinctCodes.add(entry.code);
        contributionByCode.set(entry.code, (contributionByCode.get(entry.code) ?? 0) + entry.ret);
      }
    }
    const worst = Array.from(contributionByCode.entries())
      .map(([code, sumRet]) => ({ code, sumRetPct: sumRet * 100 }))
      .sort((a, b) => a.sumRetPct - b.sumRetPct)
      .slice(0, 5);

    console.log(
      `\n  [${ruleType}] MDD 구간(${dd.peakDate}~${dd.troughDate}) 중 보유 종목 ${distinctCodes.size}개, 최악 기여 5개:`
    );
    for (const w of worst) {
      console.log(`    ${w.code}: 구간 내 수익률 합 ${w.sumRetPct.toFixed(1)}%p`);
    }

    for (const market of ["KOSPI", "KOSDAQ"] as const) {
      try {
        const indexRows = await getIndexPriceSeries(market, dd.peakDate, dd.troughDate);
        if (indexRows.length >= 2) {
          const changePct = ((indexRows[indexRows.length - 1].closePrice - indexRows[0].closePrice) / indexRows[0].closePrice) * 100;
          console.log(`    ${market} 같은 구간 변화: ${changePct.toFixed(1)}% (${indexRows.length}거래일)`);
        } else {
          console.log(`    ${market} 지수 데이터 없음(구간 내 ${indexRows.length}건) — 커버리지 확인 필요`);
        }
      } catch (error) {
        console.log(`    ${market} 지수 조회 실패: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  // === 3. 활성일 교집합 기준 상관계수(reversal_breakout/v2 vs peg_lynch) ===
  console.log("\n=== 3. 활성일 교집합 기준 상관계수 ===");
  for (const a of DETAIL_TRACKED_RULE_TYPES) {
    const b: TargetRuleType = "peg_lynch";
    const overlapIndices: number[] = [];
    sortedDates.forEach((d, i) => {
      const activeA = (dailyActiveCount[a].get(d) ?? 0) > 0;
      const activeB = (dailyActiveCount[b].get(d) ?? 0) > 0;
      if (activeA && activeB) overlapIndices.push(i);
    });
    const activeADays = sortedDates.filter((d) => (dailyActiveCount[a].get(d) ?? 0) > 0).length;
    const activeBDays = sortedDates.filter((d) => (dailyActiveCount[b].get(d) ?? 0) > 0).length;

    const corrAll = pearsonCorrelation(seriesByRuleType[a], seriesByRuleType[b]);
    const overlapA = overlapIndices.map((i) => seriesByRuleType[a][i]);
    const overlapB = overlapIndices.map((i) => seriesByRuleType[b][i]);
    const corrOverlap = pearsonCorrelation(overlapA, overlapB);

    console.log(
      `  [${a} vs ${b}] 활성일: ${a}=${activeADays}일, ${b}=${activeBDays}일, 교집합=${overlapIndices.length}일(전체 ${sortedDates.length}일 중)`
    );
    console.log(`  [${a} vs ${b}] 전체기간 상관계수 ${corrAll.toFixed(3)} vs 교집합일만 상관계수 ${corrOverlap.toFixed(3)}`);
  }

  // === 4. ma_cross vs minervini 구조적 중복 여부(연도별 상관계수 + 부호 일치율) ===
  console.log("\n=== 4. ma_cross vs minervini 연도별 상관계수 ===");
  const maActiveDays = sortedDates.filter((d) => (dailyActiveCount.ma_cross.get(d) ?? 0) > 0).length;
  const minerviniActiveDays = sortedDates.filter((d) => (dailyActiveCount.minervini_trend_template.get(d) ?? 0) > 0).length;
  console.log(
    `  활성일: ma_cross=${maActiveDays}일, minervini=${minerviniActiveDays}일 (전체 ${sortedDates.length}일 — 둘 다 거의 매일 활성)`
  );

  const years = Array.from(new Set(sortedDates.map((d) => d.slice(0, 4)))).sort();
  for (const year of years) {
    const indices: number[] = [];
    sortedDates.forEach((d, i) => {
      if (d.startsWith(year)) indices.push(i);
    });
    const a = indices.map((i) => seriesByRuleType.ma_cross[i]);
    const b = indices.map((i) => seriesByRuleType.minervini_trend_template[i]);
    console.log(`  ${year}: 상관계수 ${pearsonCorrelation(a, b).toFixed(3)} (${indices.length}거래일)`);
  }

  let sameSignCount = 0;
  let comparableCount = 0;
  for (let i = 0; i < sortedDates.length; i++) {
    const a = seriesByRuleType.ma_cross[i];
    const b = seriesByRuleType.minervini_trend_template[i];
    if (a === 0 && b === 0) continue;
    comparableCount++;
    if (Math.sign(a) === Math.sign(b)) sameSignCount++;
  }
  console.log(
    `  일별 수익률 부호 일치율: ${((sameSignCount / comparableCount) * 100).toFixed(1)}% (${sameSignCount}/${comparableCount}일)`
  );

  console.log("\n완료");
}

main().catch((error) => {
  console.error("진단 중 오류:", error);
  process.exit(1);
});
