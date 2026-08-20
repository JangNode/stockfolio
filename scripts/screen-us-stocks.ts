/**
 * 미국 주식(당분간 나스닥+뉴욕, lib/stockMasterOverseas.ts의 ACTIVE_EXCHANGES 참고)을 대상으로
 * 저장된 전략(strategies.market='US')들을 스캔해
 * screening_results 테이블을 갱신하는 배치 스크립트. scripts/screen-all-stocks.ts와 같은
 * 전략 판정 엔진(lib/backtest.ts)·점수 계산(lib/screeningScore.ts)을 그대로 재사용하지만,
 * 시세/종목마스터 조회가 완전히 다르고 스케줄(뉴욕 마감 기준, DST 반영)도 달라 별도
 * 스크립트로 분리했다. GitHub Actions에서 매일 실행된다 (.github/workflows/screening-us.yml).
 *
 * 필드명(lib/kis.ts의 해외주식 함수들)은 KIS 공식 예제 저장소를 기준으로 했고, 이 환경에는
 * 실제 KIS 계정으로 라이브 검증할 방법이 없었다 — 운영 투입 전 소수 종목으로 스팟체크 필요.
 *
 *   tsx --conditions=react-server scripts/screen-us-stocks.ts
 * (package.json의 screen:us-stocks 스크립트가 이 플래그를 포함한다.)
 *
 * 필요 환경변수: KIS_APP_KEY, KIS_APP_SECRET, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  getKisCallStats,
  getOverseasDailyPrices,
  getOverseasPriceDetail,
  getOverseasStockPrice,
  type OverseasExchangeCode,
} from "@/lib/kis";
import { getAllOverseasStocks, type OverseasStockEntry } from "@/lib/stockMasterOverseas";
import { determineUsBatchSchedule, getUsBatchTradingDate } from "@/lib/usMarketCalendar";
import {
  computeEntryPlan,
  evaluateTrackingStatus,
  matchesToday,
  type DailyPrice,
  type StrategyRule,
} from "@/lib/backtest";
import { computeSignalScore } from "@/lib/screeningScore";

// ===== 잡주 필터링 조건 =====
// 영문 종목명에 이 패턴이 매치되면 제외한다(SPAC). 국내와 달리 미국 마스터파일엔 SPAC
// 여부를 나타내는 별도 필드가 없어 이름 패턴에 의존한다 — 국내의 "스팩" 문자열 매칭보다
// 오탐/누락 가능성이 크다는 점을 감안한다(시가총액 필터가 상당수를 추가로 걸러낸다).
const SPAC_NAME_PATTERN = /\bacquisition\s+(corp|corporation|company|co)\b|\bspac\b/i;
// 이 시가총액(달러) 미만인 종목은 제외한다.
const MIN_MARKET_CAP_USD = 500_000_000;
// 이 가격(달러) 미만인 종목(동전주)은 제외한다. 국내(₩1,000)에 대응하는 미국 관례 기준으로,
// 사용자가 별도로 지정하지 않아 임의로 정한 값이다 — 필요하면 조정.
const MIN_PRICE_USD = 1;
// 점수 계산(안정성 항목)에서 시가총액이 이 값(달러) 이상이면 만점으로 친다.
const MARKET_CAP_SCORE_FULL_USD = 5_000_000_000;

// 미너비니 템플릿은 250거래일 신고/신저가 조건이 필요해 넉넉히 300건을 받는다. 해외
// dailyprice는 페이지당 정확히 몇 건을 주는지 문서로 확인 못 해(lib/kis.ts 주석 참고)
// 최대 페이지 수로만 상한을 둔다.
const DAILY_TARGET_ROWS_DEFAULT = 100;
const MINERVINI_DAILY_TARGET_ROWS = 300;

const BATCH_CONCURRENCY = 10;
const CALL_RETRY_COUNT = 2;
const CALL_RETRY_DELAY_MS = 2000;
const PROGRESS_LOG_INTERVAL = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** scripts/screen-all-stocks.ts와 동일한 동시성 유틸 — 두 배치가 각자 self-contained하게
 * 유지되도록 의도적으로 별도 lib로 뽑지 않고 그대로 중복한다. */
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
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

type StrategyRow = StrategyRule & { id: string; name: string | null };

async function loadStrategies(): Promise<StrategyRow[]> {
  const { data, error } = await supabaseAdmin
    .from("strategies")
    .select("id, name, rule_type, rule_params")
    .eq("market", "US");

  if (error) throw new Error(`전략 조회 실패: ${error.message}`);
  return (data ?? []) as StrategyRow[];
}

function computeDailyTargetRows(strategies: StrategyRow[]): number {
  let target = DAILY_TARGET_ROWS_DEFAULT;

  for (const strategy of strategies) {
    if (strategy.rule_type === "minervini_trend_template") {
      target = Math.max(target, MINERVINI_DAILY_TARGET_ROWS);
    } else {
      target = Math.max(target, strategy.rule_params.long_period + 20);
    }
  }

  return target;
}

interface MasterFilterCounts {
  spac: number;
}

/** SPAC 이름 패턴만 마스터파일 단계에서 거른다 — ETF/지수/워런트는 이미
 * lib/stockMasterOverseas.ts가 파싱 시점에 securityType으로 제외했고, 신규상장 필터는
 * 해외 마스터파일에 상장일 필드가 없어 적용할 수 없다(이 부분은 시가총액 필터로 일부 대체). */
function filterByMaster(
  stocks: OverseasStockEntry[]
): { survivors: OverseasStockEntry[]; counts: MasterFilterCounts } {
  const counts: MasterFilterCounts = { spac: 0 };
  const survivors: OverseasStockEntry[] = [];

  for (const stock of stocks) {
    if (SPAC_NAME_PATTERN.test(stock.name)) {
      counts.spac++;
      continue;
    }
    survivors.push(stock);
  }

  return { survivors, counts };
}

async function filterByQuote(
  stocks: OverseasStockEntry[]
): Promise<{
  survivors: OverseasStockEntry[];
  marketCapByCode: Map<string, number>;
  excludedCount: number;
  fetchErrors: number;
}> {
  const survivors: OverseasStockEntry[] = [];
  const marketCapByCode = new Map<string, number>();
  let excludedCount = 0;
  let fetchErrors = 0;
  let completed = 0;

  await runWithConcurrency(stocks, BATCH_CONCURRENCY, async (stock) => {
    try {
      const detail = await withRetry(
        () => getOverseasPriceDetail(stock.exchange, stock.code, "batch"),
        `${stock.code}(${stock.name}) 시세상세 조회`
      );

      if (detail.currentPrice < MIN_PRICE_USD || detail.marketCap < MIN_MARKET_CAP_USD) {
        excludedCount++;
      } else {
        survivors.push(stock);
        marketCapByCode.set(stock.code, detail.marketCap);
      }
    } catch (error) {
      fetchErrors++;
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `    ${stock.code}(${stock.name}) 시세상세 조회 실패, 이번 실행에서는 건너뜁니다: ${message}`
      );
    } finally {
      completed++;
      if (
        completed === 1 ||
        completed % PROGRESS_LOG_INTERVAL === 0 ||
        completed === stocks.length
      ) {
        console.log(
          `  [${completed}/${stocks.length}] 시세 필터 진행 중... (제외 ${excludedCount}건, 조회 실패 ${fetchErrors}건)`
        );
      }
    }
  });

  return { survivors, marketCapByCode, excludedCount, fetchErrors };
}

interface ActiveRow {
  id: string;
  stock_code: string;
  exchange: string | null;
  entry_price: number;
  stop_loss_price: number;
  take_profit_price: number;
}

async function updateActiveTracking(): Promise<{
  updated: number;
  stopped: number;
  profited: number;
}> {
  console.log("=== 1단계: 기존 추적 종목 갱신 ===");

  const { data: activeRows, error } = await supabaseAdmin
    .from("screening_results")
    .select("id, stock_code, exchange, entry_price, stop_loss_price, take_profit_price")
    .eq("status", "active")
    .eq("market", "US");

  if (error) throw new Error(`추적 종목 조회 실패: ${error.message}`);

  if (!activeRows || activeRows.length === 0) {
    console.log("추적 중인 종목이 없습니다.");
    return { updated: 0, stopped: 0, profited: 0 };
  }

  console.log(`추적 중인 종목 ${activeRows.length}건`);

  const priceByCode = new Map<string, number>();
  let completed = 0;

  await runWithConcurrency(activeRows as ActiveRow[], BATCH_CONCURRENCY, async (row) => {
    if (!row.exchange) {
      console.error(`    ${row.stock_code} 거래소 코드 누락, 건너뜁니다.`);
      return;
    }
    try {
      const price = await withRetry(
        () => getOverseasStockPrice(row.exchange as OverseasExchangeCode, row.stock_code, "batch"),
        `${row.stock_code} 현재가 조회`
      );
      priceByCode.set(row.stock_code, price.currentPrice);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`    ${row.stock_code} 현재가 조회 실패, 이번 실행에서는 건너뜁니다: ${message}`);
    } finally {
      completed++;
      if (
        completed === 1 ||
        completed % PROGRESS_LOG_INTERVAL === 0 ||
        completed === activeRows.length
      ) {
        console.log(`  [${completed}/${activeRows.length}] 현재가 조회 진행 중...`);
      }
    }
  });

  let updated = 0;
  let stopped = 0;
  let profited = 0;

  for (const row of activeRows as ActiveRow[]) {
    const currentPrice = priceByCode.get(row.stock_code);
    if (currentPrice === undefined) continue;

    const returnPct = ((currentPrice - row.entry_price) / row.entry_price) * 100;
    const status = evaluateTrackingStatus(currentPrice, row.stop_loss_price, row.take_profit_price);

    const update: Record<string, unknown> = {
      current_price: currentPrice,
      return_pct: returnPct,
    };
    if (status !== "active") {
      update.status = status;
      update.closed_at = new Date().toISOString();
    }

    const { error: updateError } = await supabaseAdmin
      .from("screening_results")
      .update(update)
      .eq("id", row.id);

    if (updateError) {
      console.error(`    ${row.stock_code} 갱신 실패: ${updateError.message}`);
      continue;
    }

    updated++;
    if (status === "stopped") {
      stopped++;
      console.log(`    ✕ 손절 처리: ${row.stock_code} (${currentPrice} ≤ ${row.stop_loss_price})`);
    } else if (status === "profited") {
      profited++;
      console.log(`    ✓ 익절 처리: ${row.stock_code} (${currentPrice} ≥ ${row.take_profit_price})`);
    }
  }

  console.log(`갱신 완료: ${updated}건 (손절 ${stopped}건, 익절 ${profited}건)`);
  return { updated, stopped, profited };
}

interface StockPriceEntry {
  name: string;
  exchange: OverseasExchangeCode;
  prices: DailyPrice[];
}

async function collectDailyPrices(
  stocks: OverseasStockEntry[],
  dailyTargetRows: number
): Promise<{ priceByCode: Map<string, StockPriceEntry>; fetchErrors: number }> {
  console.log(`=== 3단계: 대상 종목 일봉 데이터 수집 (종목당 ${dailyTargetRows}건) ===`);

  const priceByCode = new Map<string, StockPriceEntry>();
  let fetchErrors = 0;
  let completed = 0;

  await runWithConcurrency(stocks, BATCH_CONCURRENCY, async (stock) => {
    try {
      const prices = await withRetry(
        () => getOverseasDailyPrices(stock.exchange, stock.code, "D", dailyTargetRows, "batch"),
        `${stock.code}(${stock.name}) 일봉 조회`
      );
      if (prices.length > 0) {
        priceByCode.set(stock.code, { name: stock.name, exchange: stock.exchange, prices });
      }
    } catch (error) {
      fetchErrors++;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`    ${stock.code}(${stock.name}) 일봉 조회 실패, 건너뜁니다: ${message}`);
    } finally {
      completed++;
      if (
        completed === 1 ||
        completed % PROGRESS_LOG_INTERVAL === 0 ||
        completed === stocks.length
      ) {
        console.log(`  [${completed}/${stocks.length}] 데이터 수집 중... (조회 실패 ${fetchErrors}건)`);
      }
    }
  });

  console.log(`데이터 수집 완료: ${priceByCode.size}개 종목 확보, 조회 실패 ${fetchErrors}건`);
  return { priceByCode, fetchErrors };
}

async function runStrategyScan(
  strategy: StrategyRow,
  priceByCode: Map<string, StockPriceEntry>,
  activeKeys: Set<string>,
  marketCapByCode: Map<string, number>
): Promise<{ matched: number; errors: number }> {
  const label = `${strategy.name ?? strategy.rule_type}(${strategy.rule_type})`;
  console.log(`  --- [${label}] 판정 시작 (대상 ${priceByCode.size}종목) ---`);

  let matched = 0;
  let errors = 0;

  for (const [stockCode, { name: stockName, exchange, prices }] of priceByCode) {
    try {
      if (!matchesToday(prices, strategy)) continue;

      const key = `${strategy.id}:${stockCode}`;
      if (activeKeys.has(key)) continue;

      const signalPrice = prices[prices.length - 1].close;
      const { entryPrice, stopLossPrice, takeProfitPrice } = computeEntryPlan(prices, strategy);
      const marketCapUsd = marketCapByCode.get(stockCode) ?? null;
      const score = computeSignalScore(
        prices,
        strategy,
        marketCapUsd === null ? null : marketCapUsd / MARKET_CAP_SCORE_FULL_USD
      );

      const { error: insertError } = await supabaseAdmin.from("screening_results").insert({
        strategy_id: strategy.id,
        stock_code: stockCode,
        stock_name: stockName,
        signal_price: signalPrice,
        entry_price: entryPrice,
        stop_loss_price: stopLossPrice,
        take_profit_price: takeProfitPrice,
        current_price: signalPrice,
        return_pct: 0,
        status: "active",
        score,
        market: "US",
        exchange,
      });

      if (insertError) {
        errors++;
        console.error(`    [${label}] ${stockCode} 저장 실패: ${insertError.message}`);
        continue;
      }

      activeKeys.add(key);
      matched++;
      console.log(
        `    [${label}] ✓ 신규 매칭: ${stockName}(${stockCode}) (진입가 $${entryPrice.toLocaleString("en-US")}, 점수 ${score})`
      );
    } catch (error) {
      errors++;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`    [${label}] ${stockCode} 판정 중 오류, 건너뜁니다: ${message}`);
    }
  }

  console.log(`  --- [${label}] 판정 완료: 신규 매칭 ${matched}건, 오류 ${errors}건 ---`);
  return { matched, errors };
}

async function scanAllStocks(
  strategies: StrategyRow[]
): Promise<{ scanned: number; matched: number; errors: number }> {
  if (strategies.length === 0) {
    console.log("등록된 미국주식 전략이 없어 스캔을 건너뜁니다.");
    return { scanned: 0, matched: 0, errors: 0 };
  }

  console.log("=== 2단계: 잡주 필터링 ===");

  const allStocks = await getAllOverseasStocks();
  const { survivors: masterSurvivors, counts: masterCounts } = filterByMaster(allStocks);
  console.log(
    `  마스터 필터: ${allStocks.length}개 → ${masterSurvivors.length}개 (SPAC 추정 ${masterCounts.spac}개 제외)`
  );

  console.log(`  시세 필터 조회 중... (대상 ${masterSurvivors.length}개)`);
  const {
    survivors: finalStocks,
    marketCapByCode,
    excludedCount: quoteExcluded,
    fetchErrors: quoteFetchErrors,
  } = await filterByQuote(masterSurvivors);
  console.log(
    `  시세 필터: ${masterSurvivors.length}개 → ${finalStocks.length}개 ` +
      `(저시가총액/동전주 ${quoteExcluded}개 제외, 조회 실패 ${quoteFetchErrors}건)`
  );
  console.log(`최종 스캔 대상: ${finalStocks.length}개 종목`);

  const dailyTargetRows = computeDailyTargetRows(strategies);
  console.log(
    `등록 전략 ${strategies.length}개(${strategies.map((s) => s.rule_type).join(", ")}), ` +
      `종목당 일봉 목표 ${dailyTargetRows}건`
  );

  const { priceByCode, fetchErrors } = await collectDailyPrices(finalStocks, dailyTargetRows);

  const { data: existingActive, error: activeError } = await supabaseAdmin
    .from("screening_results")
    .select("strategy_id, stock_code")
    .eq("status", "active")
    .eq("market", "US");

  if (activeError) throw new Error(`추적 중인 종목 조회 실패: ${activeError.message}`);

  const activeKeys = new Set(
    (existingActive ?? []).map((r) => `${r.strategy_id}:${r.stock_code}`)
  );

  console.log(`=== 4단계: 전략별 판정 (${strategies.length}개 전략, 전략마다 독립적으로 진행) ===`);

  let totalMatched = 0;
  let totalErrors = fetchErrors + quoteFetchErrors;

  for (const strategy of strategies) {
    try {
      const { matched, errors } = await runStrategyScan(
        strategy,
        priceByCode,
        activeKeys,
        marketCapByCode
      );
      totalMatched += matched;
      totalErrors += errors;
    } catch (error) {
      totalErrors++;
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `  전략 "${strategy.name ?? strategy.rule_type}" 판정이 처리되지 않은 오류로 중단됐습니다: ${message}`
      );
    }
  }

  console.log(`스캔 완료: 신규 매칭 ${totalMatched}건, 오류 ${totalErrors}건`);
  return { scanned: finalStocks.length, matched: totalMatched, errors: totalErrors };
}

async function recordRun(
  startedAt: Date,
  scanned: number,
  matched: number,
  errors: number
): Promise<void> {
  const { error } = await supabaseAdmin.from("screening_runs").insert({
    started_at: startedAt.toISOString(),
    finished_at: new Date().toISOString(),
    scanned_count: scanned,
    matched_count: matched,
    error_count: errors,
  });

  if (error) {
    console.error(`실행 기록 저장 실패: ${error.message}`);
  }
}

async function main(): Promise<void> {
  const startedAt = new Date();
  console.log(`미국주식 스크리닝 배치 시작: ${startedAt.toISOString()}`);

  // .github/workflows/screening-us.yml은 서머타임용(UTC 19시)·표준시용(UTC 20시) 크론을
  // 둘 다 등록해뒀다(정규장 마감 1시간 전인 동부시간 15:00을 노린 것). 그래서 평일마다
  // 이 배치가 하루 두 번 트리거되는데, 그중 오늘 서머타임 여부에 맞지 않는 한 번은 여기서
  // 걸러 즉시 종료한다. workflow_dispatch로 수동 실행할 때는 이 가드를 적용하지 않는다.
  const isScheduledRun = process.env.GITHUB_EVENT_NAME === "schedule";
  if (isScheduledRun) {
    const schedule = determineUsBatchSchedule(startedAt);
    console.log(schedule.reason);
    if (!schedule.shouldRun) {
      return;
    }
  }

  // 그래도 주말/휴장일에 워크플로가 잘못 걸릴 경우를 대비해 여기서 한 번 더 가드한다.
  const { dateKey, isTradingDay } = getUsBatchTradingDate();
  if (!isTradingDay) {
    console.log(`오늘(뉴욕 기준 ${dateKey})은 미국 증시 휴장일입니다. 배치를 건너뜁니다.`);
    await recordRun(startedAt, 0, 0, 0);
    return;
  }
  console.log(`대상 거래일(뉴욕 기준): ${dateKey}`);

  const strategies = await loadStrategies();
  console.log(`등록된 미국주식 전략 수: ${strategies.length}`);

  await updateActiveTracking();
  const { scanned, matched, errors } = await scanAllStocks(strategies);

  await recordRun(startedAt, scanned, matched, errors);

  const elapsedSec = ((Date.now() - startedAt.getTime()) / 1000).toFixed(1);
  const kisStats = getKisCallStats();
  console.log(
    `미국주식 스크리닝 배치 종료: ${elapsedSec}초 소요 (KIS 호출 ${kisStats.total}건, ` +
      `EGW00201 재시도 ${kisStats.retried}건)`
  );
}

main().catch((error) => {
  console.error("배치 실행 중 오류가 발생했습니다:", error);
  process.exit(1);
});
