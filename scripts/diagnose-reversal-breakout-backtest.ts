/**
 * (임시) "급등주 찾기"(역배열 반등, rule_type: reversal_breakout) 전략의 실제 과거 데이터
 * 성과를 확인하기 위한 읽기 전용 진단 스크립트. DB에 아무것도 insert/update하지 않는다
 * (kis_tokens 캐시 테이블 읽기/쓰기는 lib/kis.ts의 기존 토큰 캐시 인프라라 예외).
 *
 * 확인 항목(사용자 요청):
 * 1) 단계별(역배열 이력 → 매집봉 → 전환신호) 통과 신호/종목 수
 * 2) 성과: 기간 총수익률, 승률, 평균 보유기간, MDD, 매매 횟수
 * 3) 코스피/코스닥 지수 대비 성과
 *
 * 판정 로직은 재구현하지 않고 lib/reversalBreakout.ts(computeInverseAlignmentRatio/
 * findAccumulationBar/computeBreakoutFreshness/computePrevAverageVolume)와
 * lib/backtest.ts(runBacktest/aggregateTrades)를 그대로 재사용한다.
 *
 * 종목 유니버스는 scripts/run-custom-backtest.ts의 filterKrByMaster/filterKrByQuote와
 * 동일한 기준(scripts/screen-all-stocks.ts의 마스터 필터와 동등)을 이 스크립트 안에
 * 그대로 복제해 쓴다 — 배치 스크립트들이 각자 self-contained하게 상수를 중복하는
 * 기존 관례(run-custom-backtest.ts 주석 참고)를 따른다.
 *
 * 필요 환경변수: KIS_APP_KEY, KIS_APP_SECRET, NEXT_PUBLIC_SUPABASE_URL,
 *   SUPABASE_SERVICE_ROLE_KEY(lib/kis.ts의 kis_tokens 캐시에 필요)
 *   tsx --conditions=react-server scripts/diagnose-reversal-breakout-backtest.ts
 *
 * 확인이 끝나면(팀장이 실행 결과를 확인한 뒤) 이 스크립트와 워크플로는 정리 PR에서
 * 함께 삭제한다.
 */

import { getDailyPrices, getStockPrice, getKisCallStats } from "@/lib/kis";
import { getAllStocks, type StockEntry } from "@/lib/stockMaster";
import { runBacktest, aggregateTrades, type DailyPrice, type StrategyRule } from "@/lib/backtest";
import {
  computeInverseAlignmentRatio,
  findAccumulationBar,
  computeBreakoutFreshness,
  computePrevAverageVolume,
} from "@/lib/reversalBreakout";
import { computeSMA } from "@/lib/sma";
import {
  REVERSAL_BREAKOUT_MA_PERIODS,
  REVERSAL_MIN_INVERSE_RATIO,
  BREAKOUT_LOOKBACK_DAYS,
  REVERSAL_BREAKOUT_MIN_HISTORY_ROWS,
} from "@/lib/reversalBreakoutConfig";

const BATCH_CONCURRENCY = 10;
const CALL_RETRY_COUNT = 2;
const CALL_RETRY_DELAY_MS = 2000;
const PROGRESS_LOG_INTERVAL = 50;

// KIS getDailyPrices/getOverseasDailyPrices의 실질 상한(페이지당 100건 x 최대 8페이지,
// lib/kis.ts MAX_CHART_PAGES 참고). MA448 워밍업(507건 이상) + 실제 신호 테스트 구간을
// 최대한 확보하기 위해 상한을 그대로 요청한다.
const TARGET_DAILY_ROWS = 800;

// scripts/screen-all-stocks.ts의 마스터 필터(EXCLUDED_NAME_SUBSTRINGS/EXCLUDED_PRODUCT_TYPES/
// MIN_LISTED_MONTHS)와 scripts/run-custom-backtest.ts의 filterKrByMaster/filterKrByQuote(시가총액/
// 동전주 필터)를 그대로 복제한다.
const KR_EXCLUDED_NAME_SUBSTRINGS = ["스팩"];
const KR_EXCLUDED_PRODUCT_TYPES = new Set(["RT", "EF", "EN"]);
const KR_MIN_LISTED_MONTHS = 6;
const KR_MIN_MARKET_CAP_EOK = 500;
const KR_MIN_PRICE_WON = 1000;

// 코스피/코스닥 업종지수 코드(lib/kis.ts getDomesticIndex가 현재가 조회에 쓰는 코드와 동일).
const KOSPI_INDEX_CODE = "0001";
const KOSDAQ_INDEX_CODE = "1001";
// 지수 API 소량 테스트에 쓸 행 수.
const INDEX_PROBE_ROWS = 10;
// 지수 비교용 조회 행 수(백테스트 기간 커버 목적, 여유 있게 잡는다).
const INDEX_COMPARISON_ROWS = 400;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= CALL_RETRY_COUNT; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < CALL_RETRY_COUNT) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`    [재시도 ${attempt + 1}/${CALL_RETRY_COUNT}] ${label}: ${message}`);
        await sleep(CALL_RETRY_DELAY_MS);
      }
    }
  }
  throw lastError;
}

function monthsSinceListing(listedDate: string | null, now: Date): number | null {
  if (!listedDate) return null;
  const year = Number(listedDate.slice(0, 4));
  const month = Number(listedDate.slice(4, 6));
  const day = Number(listedDate.slice(6, 8));
  if (year < 1950 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const listed = new Date(year, month - 1, day);
  if (Number.isNaN(listed.getTime())) return null;
  return (
    (now.getFullYear() - listed.getFullYear()) * 12 +
    (now.getMonth() - listed.getMonth()) -
    (now.getDate() < listed.getDate() ? 1 : 0)
  );
}

function filterKrByMaster(stocks: StockEntry[]): StockEntry[] {
  const now = new Date();
  return stocks.filter((stock) => {
    if (KR_EXCLUDED_NAME_SUBSTRINGS.some((s) => stock.name.includes(s))) return false;
    if (KR_EXCLUDED_PRODUCT_TYPES.has(stock.productType)) return false;
    if (stock.isTradingHalted || stock.isLiquidationTrading || stock.isAdministrativeIssue) return false;
    const months = monthsSinceListing(stock.listedDate, now);
    if (months !== null && months < KR_MIN_LISTED_MONTHS) return false;
    return true;
  });
}

async function filterKrByQuote(stocks: StockEntry[]): Promise<StockEntry[]> {
  const survivors: StockEntry[] = [];
  let completed = 0;

  await runWithConcurrency(stocks, BATCH_CONCURRENCY, async (stock) => {
    try {
      const price = await withRetry(() => getStockPrice(stock.code, "batch"), `${stock.code}(${stock.name}) 시세 조회`);
      if (price.currentPrice >= KR_MIN_PRICE_WON && price.marketCapEok >= KR_MIN_MARKET_CAP_EOK) {
        survivors.push(stock);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`    ${stock.code}(${stock.name}) 시세 조회 실패, 건너뜁니다: ${message}`);
    } finally {
      completed++;
      if (completed === 1 || completed % PROGRESS_LOG_INTERVAL === 0 || completed === stocks.length) {
        console.log(`  [${completed}/${stocks.length}] 시세 필터 진행 중...`);
      }
    }
  });

  return survivors;
}

interface PriceEntry {
  code: string;
  name: string;
  prices: DailyPrice[];
}

async function collectDailyPrices(stocks: StockEntry[]): Promise<PriceEntry[]> {
  const results: PriceEntry[] = [];
  let completed = 0;

  await runWithConcurrency(stocks, BATCH_CONCURRENCY, async (stock) => {
    try {
      const prices = await withRetry(
        () => getDailyPrices(stock.code, "D", TARGET_DAILY_ROWS, "batch"),
        `${stock.code}(${stock.name}) 일봉 조회`
      );
      if (prices.length > 0) results.push({ code: stock.code, name: stock.name, prices });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`    ${stock.code}(${stock.name}) 일봉 조회 실패, 건너뜁니다: ${message}`);
    } finally {
      completed++;
      if (completed === 1 || completed % PROGRESS_LOG_INTERVAL === 0 || completed === stocks.length) {
        console.log(`  [${completed}/${stocks.length}] 일봉 수집 중...`);
      }
    }
  });

  return results;
}

function daysBetweenIso(a: string, b: string): number {
  const da = new Date(a + "T00:00:00Z").getTime();
  const db = new Date(b + "T00:00:00Z").getTime();
  return Math.round((db - da) / (24 * 60 * 60 * 1000));
}

interface FunnelResult {
  windowStartDate: string;
  stage1Days: number;
  stage12Days: number;
  stage123Days: number;
  stage1Matched: boolean;
  stage12Matched: boolean;
  stage123Matched: boolean;
  trades: ReturnType<typeof runBacktest>["trades"];
}

/**
 * 종목 하나의 가격 시계열을 한 번만 순회하며 단계별(역배열→매집봉→전환신호) 통과 일수와
 * 백테스트 거래 내역을 함께 뽑는다. computeReversalBreakoutStates를 재구현하지 않고,
 * 그 함수가 내부적으로 쓰는 것과 동일한 계산 함수(computeInverseAlignmentRatio/
 * findAccumulationBar/computeBreakoutFreshness/computePrevAverageVolume)를 그대로
 * 재사용한다 — 3단계를 모두 만족하는 날의 판정 결과는 computeReversalBreakoutStates가
 * 반환하는 값과 정확히 같다(AND 조건이라 검사 순서와 무관).
 */
function analyzeStock(prices: DailyPrice[], rule: StrategyRule): FunnelResult | null {
  if (prices.length < REVERSAL_BREAKOUT_MIN_HISTORY_ROWS) return null;

  const closes = prices.map((p) => p.close);
  const volumes = prices.map((p) => p.volume);
  const smaByPeriod = REVERSAL_BREAKOUT_MA_PERIODS.map((period) => computeSMA(closes, period));
  const breakoutSma = smaByPeriod[0];
  const prevAvgVolume = computePrevAverageVolume(volumes);

  const windowStartIndex = REVERSAL_BREAKOUT_MIN_HISTORY_ROWS - 1;
  const windowStartDate = prices[windowStartIndex].date;

  let stage1Days = 0;
  let stage12Days = 0;
  let stage123Days = 0;
  let stage1Matched = false;
  let stage12Matched = false;
  let stage123Matched = false;

  for (let i = windowStartIndex; i < prices.length; i++) {
    const alignment = computeInverseAlignmentRatio(smaByPeriod, i);
    if (alignment.validDays === 0) continue;
    if (alignment.ratio < REVERSAL_MIN_INVERSE_RATIO) continue;

    stage1Days++;
    stage1Matched = true;

    const accumulation = findAccumulationBar(prices, prevAvgVolume, i);
    if (!accumulation) continue;

    stage12Days++;
    stage12Matched = true;

    const breakout = computeBreakoutFreshness(prices, breakoutSma, i);
    if (!breakout || breakout.daysSinceStart >= BREAKOUT_LOOKBACK_DAYS) continue;

    stage123Days++;
    stage123Matched = true;
  }

  const backtest = runBacktest(prices, rule, windowStartDate);

  return {
    windowStartDate,
    stage1Days,
    stage12Days,
    stage123Days,
    stage1Matched,
    stage12Matched,
    stage123Matched,
    trades: backtest.trades,
  };
}

interface IndexProbeResult {
  works: boolean;
  reason: string;
}

async function probeIndexDailyPrices(code: string, name: string): Promise<IndexProbeResult> {
  try {
    const rows = await getDailyPrices(code, "D", INDEX_PROBE_ROWS, "batch");
    console.log(`  [${name}(${code})] getDailyPrices(${INDEX_PROBE_ROWS}건 요청) 결과 ${rows.length}건:`);
    for (const row of rows.slice(-5)) {
      console.log(`    ${row.date} O:${row.open} H:${row.high} L:${row.low} C:${row.close} V:${row.volume}`);
    }
    if (rows.length === 0) {
      return { works: false, reason: "빈 배열 반환(데이터 없음)" };
    }
    // 코스피는 대략 2000~4000, 코스닥은 대략 600~1000 범위에서 움직인다(상식적 범위 검증).
    // 이 범위를 크게 벗어나면 종목 시세 엔드포인트가 지수 코드를 종목 코드로 오인해
    // 엉뚱한 값(0, 또는 임의 종목 시세)을 반환했을 가능성이 크다.
    const last = rows[rows.length - 1];
    if (last.close <= 0) {
      return { works: false, reason: `종가가 0 이하(${last.close}) — 유효한 지수 시세로 보이지 않음` };
    }
    return { works: true, reason: `정상 응답으로 보임(최근 종가 ${last.close})` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { works: false, reason: `호출 자체가 실패: ${message}` };
  }
}

async function main(): Promise<void> {
  console.log("=".repeat(80));
  console.log('"급등주 찾기"(reversal_breakout) 전략 실데이터 백테스트 진단 시작');
  console.log("=".repeat(80));

  // ===== 0) 지수 API 소량 테스트 =====
  console.log("\n[0] 코스피/코스닥 지수 일별 시세 API 소량 테스트 (getDailyPrices에 지수 코드 사용)");
  const kospiProbe = await probeIndexDailyPrices(KOSPI_INDEX_CODE, "코스피");
  const kosdaqProbe = await probeIndexDailyPrices(KOSDAQ_INDEX_CODE, "코스닥");
  console.log(`  코스피 지수 API: ${kospiProbe.works ? "정상" : "실패"} — ${kospiProbe.reason}`);
  console.log(`  코스닥 지수 API: ${kosdaqProbe.works ? "정상" : "실패"} — ${kosdaqProbe.reason}`);
  const indexApiWorks = kospiProbe.works && kosdaqProbe.works;

  // ===== 1) 종목 유니버스 구성 =====
  console.log("\n[1] 종목 유니버스 구성 (KOSPI+KOSDAQ)");
  const allStocks = await getAllStocks();
  console.log(`  전체 종목마스터: ${allStocks.length}개`);
  const masterSurvivors = filterKrByMaster(allStocks);
  console.log(
    `  마스터 필터(스팩/리츠·ETF·ETN/거래정지·정리매매·관리종목/상장 ${KR_MIN_LISTED_MONTHS}개월 미만 제외): ` +
      `${allStocks.length}개 → ${masterSurvivors.length}개`
  );
  const quoteSurvivors = await filterKrByQuote(masterSurvivors);
  console.log(
    `  시세 필터(시가총액 ${KR_MIN_MARKET_CAP_EOK}억원 미만/가격 ${KR_MIN_PRICE_WON}원 미만 제외): ` +
      `${masterSurvivors.length}개 → ${quoteSurvivors.length}개`
  );

  // ===== 2) 일봉 수집 =====
  console.log(`\n[2] 종목당 일봉 최대 ${TARGET_DAILY_ROWS}건 수집`);
  const priceEntries = await collectDailyPrices(quoteSurvivors);
  console.log(`  일봉 확보: ${quoteSurvivors.length}개 중 ${priceEntries.length}개 종목`);

  const sufficientEntries = priceEntries.filter((e) => e.prices.length >= REVERSAL_BREAKOUT_MIN_HISTORY_ROWS);
  console.log(
    `  최소 데이터(REVERSAL_BREAKOUT_MIN_HISTORY_ROWS=${REVERSAL_BREAKOUT_MIN_HISTORY_ROWS}건) 이상 확보: ` +
      `${priceEntries.length}개 → ${sufficientEntries.length}개`
  );

  // ===== 3) 단계별 통과 신호/종목 수 + 백테스트 거래 수집 =====
  console.log("\n[3] 종목별 단계별 판정 + 백테스트 거래 수집");
  const rule: StrategyRule = { rule_type: "reversal_breakout", rule_params: {} };

  let stage1Days = 0;
  let stage12Days = 0;
  let stage123Days = 0;
  const stage1Stocks = new Set<string>();
  const stage12Stocks = new Set<string>();
  const stage123Stocks = new Set<string>();
  const allTrades: ReturnType<typeof runBacktest>["trades"] = [];
  const matchedStockCodes = new Set<string>();
  let minWindowStartDate: string | null = null;
  let maxEndDate: string | null = null;

  let completed = 0;
  for (const entry of sufficientEntries) {
    completed++;
    if (completed === 1 || completed % PROGRESS_LOG_INTERVAL === 0 || completed === sufficientEntries.length) {
      console.log(`  [${completed}/${sufficientEntries.length}] 단계별 판정 중...`);
    }

    const result = analyzeStock(entry.prices, rule);
    if (!result) continue;

    stage1Days += result.stage1Days;
    stage12Days += result.stage12Days;
    stage123Days += result.stage123Days;
    if (result.stage1Matched) stage1Stocks.add(entry.code);
    if (result.stage12Matched) stage12Stocks.add(entry.code);
    if (result.stage123Matched) stage123Stocks.add(entry.code);

    if (result.trades.length > 0) {
      matchedStockCodes.add(entry.code);
      allTrades.push(...result.trades);
    }

    if (minWindowStartDate === null || result.windowStartDate < minWindowStartDate) {
      minWindowStartDate = result.windowStartDate;
    }
    const lastDate = entry.prices[entry.prices.length - 1].date;
    if (maxEndDate === null || lastDate > maxEndDate) {
      maxEndDate = lastDate;
    }
  }

  console.log("\n  --- 단계별 통과 신호/종목 수 ---");
  console.log(`  1단계(역배열 이력 70% 이상)만: ${stage1Days}일 / 고유 종목 ${stage1Stocks.size}개`);
  console.log(`  1+2단계(+매집봉): ${stage12Days}일 / 고유 종목 ${stage12Stocks.size}개`);
  console.log(`  1+2+3단계(+전환신호, 실제 매칭 시그널): ${stage123Days}일 / 고유 종목 ${stage123Stocks.size}개`);

  // ===== 4) 성과 지표 =====
  console.log("\n[4] 전체 매칭 종목 풀 성과 지표");
  const aggregate = aggregateTrades(allTrades);
  const totalHoldingDays = allTrades.reduce((sum, t) => sum + daysBetweenIso(t.buyDate, t.sellDate), 0);
  const avgHoldingDays = allTrades.length > 0 ? totalHoldingDays / allTrades.length : 0;

  console.log(`  매칭 종목 수(거래 1건 이상 발생): ${matchedStockCodes.size}개`);
  console.log(`  매매 횟수(매수 진입 건수): ${aggregate.tradeCount}건`);
  console.log(`  기간 총수익률(복리 체결 가정): ${aggregate.totalReturnPct.toFixed(2)}%`);
  console.log(`  승률: ${(aggregate.winRate * 100).toFixed(1)}%`);
  console.log(`  평균 보유기간: ${avgHoldingDays.toFixed(1)}일`);
  console.log(`  MDD(최대낙폭): ${aggregate.mddPct.toFixed(2)}%`);

  console.log(`\n  백테스트에 실제로 쓴 기간(종목별로 다를 수 있음, 최대 범위): ${minWindowStartDate} ~ ${maxEndDate}`);

  // ===== 5) 코스피/코스닥 지수 대비 성과 =====
  console.log("\n[5] 코스피/코스닥 지수 대비 성과");
  if (!indexApiWorks) {
    console.log(
      "  지수 대비 비교는 이 API로는 안 됨: getDailyPrices가 지수 코드(0001/1001)에 대해 " +
        "정상적인 시세를 반환하지 않는 것으로 확인됨(위 [0] 단계 로그 참고). " +
        "getDailyPrices는 FID_COND_MRKT_DIV_CODE를 항상 종목용 값(J)으로 고정해 호출하는데, " +
        "코스피/코스닥 지수는 별도 시장구분(U) + 별도 엔드포인트(inquire-index-price 등)가 " +
        "필요해 보인다. 우회 구현 없이 여기서 중단한다."
    );
  } else if (!minWindowStartDate || !maxEndDate) {
    console.log("  매칭된 종목이 없어 백테스트 기간을 정할 수 없습니다. 지수 비교를 생략합니다.");
  } else {
    try {
      const [kospiRows, kosdaqRows] = await Promise.all([
        getDailyPrices(KOSPI_INDEX_CODE, "D", INDEX_COMPARISON_ROWS, "batch"),
        getDailyPrices(KOSDAQ_INDEX_CODE, "D", INDEX_COMPARISON_ROWS, "batch"),
      ]);

      const computeIndexReturn = (rows: DailyPrice[]): { startDate: string; endDate: string; returnPct: number } | null => {
        const inWindow = rows.filter((r) => r.date >= minWindowStartDate! && r.date <= maxEndDate!);
        if (inWindow.length < 2) return null;
        const start = inWindow[0];
        const end = inWindow[inWindow.length - 1];
        return { startDate: start.date, endDate: end.date, returnPct: ((end.close - start.close) / start.close) * 100 };
      };

      const kospiReturn = computeIndexReturn(kospiRows);
      const kosdaqReturn = computeIndexReturn(kosdaqRows);

      if (kospiReturn) {
        console.log(
          `  코스피(${kospiReturn.startDate} → ${kospiReturn.endDate}) 등락률: ${kospiReturn.returnPct.toFixed(2)}%`
        );
      } else {
        console.log("  코스피 지수: 백테스트 기간을 커버하는 데이터가 부족해 비교 불가");
      }
      if (kosdaqReturn) {
        console.log(
          `  코스닥(${kosdaqReturn.startDate} → ${kosdaqReturn.endDate}) 등락률: ${kosdaqReturn.returnPct.toFixed(2)}%`
        );
      } else {
        console.log("  코스닥 지수: 백테스트 기간을 커버하는 데이터가 부족해 비교 불가");
      }
      console.log(`  (참고) 전략 기간 총수익률: ${aggregate.totalReturnPct.toFixed(2)}%`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`  지수 비교 조회 중 오류 발생, 비교를 건너뜁니다: ${message}`);
    }
  }

  const kisStats = getKisCallStats();
  console.log(`\nKIS 호출 통계: 총 ${kisStats.total}건 (재시도 ${kisStats.retried}건)`);
  console.log("\n진단 스크립트 종료. 이 스크립트는 읽기 전용이며 DB(screening_results 등)에 아무것도 쓰지 않았습니다.");
}

main().catch((error) => {
  console.error("진단 스크립트 실행 중 오류가 발생했습니다:", error);
  process.exit(1);
});
