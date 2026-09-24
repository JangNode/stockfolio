/**
 * [디스포저블 진단 스크립트] 포트폴리오 MDD 분석 1단계 — 5개 전략(ma_cross,
 * minervini_trend_template, reversal_breakout, reversal_breakout_v2, peg_lynch)을
 * 2016~오늘까지 동일 유니버스로 개별 백테스트해서, "전략별로 100% 자금을 투입했다고
 * 가정한" 일별 수익률(%) 시계열과 5x5 상관계수 행렬을 뽑는다. DB/Storage 쓰기 없음
 * (순수 조회+계산), 결과는 로컬 CSV/JSON 파일로만 남긴다.
 *
 * 유니버스: discoverCandidateStockCodes(lib/stockDailyPricesStorage.ts)로 2016년부터
 * 오늘까지 중 한 번이라도 시가총액 STOCK_DATA_CANDIDATE_MARKET_CAP_EOK(1조원) 이상이었던
 * 종목만 쓴다 — peg_lynch 펀더멘털 백필(scripts/backfill-stock-annual-fundamentals.ts)이
 * 후보를 고른 기준과 동일해서, 5개 전략이 같은 유니버스로 비교된다(상장폐지 종목은 이미
 * Storage에 포함돼 있어 생존편향 없음).
 *
 * ma_cross/minervini_trend_template의 rule_params는 strategies 테이블(market='KR')에
 * 활성 행이 있으면 그 값을 쓰고, 없으면 임시 기본값(ma_cross 20/60일, 미너비니 원문
 * 50/150/200일)을 쓴다 — 2026-09-24 사용자 확인. 두 전략 모두 peg_lynch/reversal_breakout과
 * 달리 rule_params가 lib/*Config.ts 상수가 아니라 사용자가 직접 넣는 개인화 값이라
 * (StrategyManager.tsx 참고) 시딩 마이그레이션이 없다.
 *
 * 포트폴리오 수익률 산출 방식: lib/backtest.ts의 runBacktest()가 반환하는 거래(매수/매도)
 * 구간에서, 매수일 다음 거래일부터 매도일까지의 종가 변화(close-to-close)를 그대로 쓴다
 * (runBacktest/computeStates 자체는 손대지 않고 그대로 재사용 — 프로덕션 코드 변경 없음).
 * 그날 그 전략에 신호가 있는 종목이 여러 개면 동일가중 평균, 신호가 하나도 없으면 그날은
 * 0%(현금 보유)로 취급한다.
 *
 * 필요 환경변수: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   tsx --conditions=react-server scripts/diagnose-strategy-daily-returns.ts
 */

import { writeFileSync } from "fs";
import { join } from "path";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  discoverCandidateStockCodes,
  getDailyPriceSeries,
  type StockDailyPriceRow,
} from "@/lib/stockDailyPricesStorage";
import { loadFundamentalsSeriesWithListedShares, type FundamentalsSeries } from "@/lib/stockFundamentals";
import { runBacktest, type StrategyRule, type DailyPrice, type MaCrossParams, type MinerviniParams } from "@/lib/backtest";
import { STOCK_DATA_CANDIDATE_MARKET_CAP_EOK } from "@/lib/stockDataConfig";
import type { ListedSharesByFiscalYear } from "@/lib/pegRatio";

const UNIVERSE_START_YEAR = 2016;
const CURRENT_YEAR = new Date().getUTCFullYear();
const TODAY = new Date().toISOString().slice(0, 10);
// 미너비니 250봉(신고/신저가)+20봉(추세 확인) 워밍업이 2016-01-01에 이미 끝나 있도록
// 넉넉히 2년 전부터 가격을 받아온다.
const PRICE_FETCH_START_DATE = "2014-01-01";
const WINDOW_START_DATE = `${UNIVERSE_START_YEAR}-01-01`;

const BATCH_CONCURRENCY = 10;
const PROGRESS_LOG_INTERVAL = 100;

// 2026-09-24 사용자 확인: 활성 전략이 없을 때 쓰는 임시 기본값.
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

const OUTPUT_CSV_PATH = join(process.cwd(), "strategy-daily-returns.csv");
const OUTPUT_JSON_PATH = join(process.cwd(), "strategy-daily-returns.json");

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
  console.log(`포트폴리오 MDD 분석용 일별 수익률 시계열 추출 시작: ${new Date().toISOString()}`);

  const [maCrossActive, minerviniActive] = await Promise.all([
    loadActiveRuleParams("ma_cross"),
    loadActiveRuleParams("minervini_trend_template"),
  ]);

  const maCrossParams = (maCrossActive as unknown as MaCrossParams | null) ?? FALLBACK_MA_CROSS_PARAMS;
  const minerviniParams = (minerviniActive as unknown as MinerviniParams | null) ?? FALLBACK_MINERVINI_PARAMS;
  console.log(
    maCrossActive
      ? `ma_cross 활성 전략 사용: ${JSON.stringify(maCrossParams)}`
      : `⚠ ma_cross 활성 전략 없음 — 기본값 사용: ${JSON.stringify(maCrossParams)}`
  );
  console.log(
    minerviniActive
      ? `minervini_trend_template 활성 전략 사용: ${JSON.stringify(minerviniParams)}`
      : `⚠ minervini_trend_template 활성 전략 없음 — 기본값 사용: ${JSON.stringify(minerviniParams)}`
  );

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
  console.log(`유니버스: ${universe.length}개 종목 (2016~ 시가총액 1조원 이상 이력)`);

  const allDates = new Set<string>();
  const returnsByRuleType: Record<TargetRuleType, Map<string, number[]>> = {
    ma_cross: new Map(),
    minervini_trend_template: new Map(),
    reversal_breakout: new Map(),
    reversal_breakout_v2: new Map(),
    peg_lynch: new Map(),
  };

  function addContribution(ruleType: TargetRuleType, date: string, ret: number): void {
    const map = returnsByRuleType[ruleType];
    const arr = map.get(date);
    if (arr) arr.push(ret);
    else map.set(date, [ret]);
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
          WINDOW_START_DATE,
          needsFundamentals ? fundamentals : undefined,
          needsFundamentals ? listedSharesByFiscalYear : undefined
        );
        if (result.insufficientData || result.trades.length === 0) continue;

        for (const trade of result.trades) {
          const buyIdx = dateIndex.get(trade.buyDate);
          const sellIdx = dateIndex.get(trade.sellDate);
          if (buyIdx === undefined || sellIdx === undefined) continue;

          for (let i = buyIdx + 1; i <= sellIdx; i++) {
            const date = prices[i].date;
            if (date < WINDOW_START_DATE) continue;
            const dailyReturn = (prices[i].close - prices[i - 1].close) / prices[i - 1].close;
            addContribution(ruleType, date, dailyReturn);
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

  const sortedDates = Array.from(allDates).sort();
  console.log(`\n전체 거래일수: ${sortedDates.length}일 (${sortedDates[0]} ~ ${sortedDates[sortedDates.length - 1]})`);

  const rows = sortedDates.map((date) => {
    const row: Record<string, string | number> = { date };
    for (const ruleType of TARGET_RULE_TYPES) {
      const contributions = returnsByRuleType[ruleType].get(date);
      const ret =
        contributions && contributions.length > 0
          ? contributions.reduce((s, v) => s + v, 0) / contributions.length
          : 0;
      row[ruleType] = Number((ret * 100).toFixed(4));
    }
    return row;
  });

  const header = ["date", ...TARGET_RULE_TYPES].join(",");
  const csvLines = [header, ...rows.map((r) => [r.date, ...TARGET_RULE_TYPES.map((rt) => r[rt])].join(","))];
  writeFileSync(OUTPUT_CSV_PATH, csvLines.join("\n"));
  writeFileSync(OUTPUT_JSON_PATH, JSON.stringify(rows));
  console.log(`결과 저장: ${OUTPUT_CSV_PATH}, ${OUTPUT_JSON_PATH}`);

  console.log("\n=== 전략별 요약(2016~오늘, 동일가중 100% 투입 가정) ===");
  const seriesByRuleType: Record<TargetRuleType, number[]> = {} as Record<TargetRuleType, number[]>;
  for (const ruleType of TARGET_RULE_TYPES) {
    const series = rows.map((r) => r[ruleType] as number);
    seriesByRuleType[ruleType] = series;
    const activeDays = series.filter((v) => v !== 0).length;
    const { totalReturnPct, mddPct } = computeCumulativeAndMdd(series);
    console.log(
      `  [${ruleType}] 활성일 ${activeDays}/${series.length}일, 누적수익률 ${totalReturnPct.toFixed(1)}%, MDD ${mddPct.toFixed(1)}%`
    );
  }

  console.log("\n=== 5x5 상관계수 행렬(일별 수익률) ===");
  console.log(["", ...TARGET_RULE_TYPES].join("\t"));
  for (const a of TARGET_RULE_TYPES) {
    const line: string[] = [a];
    for (const b of TARGET_RULE_TYPES) {
      line.push(pearsonCorrelation(seriesByRuleType[a], seriesByRuleType[b]).toFixed(3));
    }
    console.log(line.join("\t"));
  }

  console.log("\n완료");
}

main().catch((error) => {
  console.error("진단 중 오류:", error);
  process.exit(1);
});
