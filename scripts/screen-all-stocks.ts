/**
 * 한국 주식(KOSPI+KOSDAQ) 전종목을 대상으로 저장된 전략들을 스캔해 screening_results
 * 테이블을 갱신하는 배치 스크립트. GitHub Actions에서 매일 실행된다 (.github/workflows/screening.yml).
 *
 * server-only로 막힌 lib/kis.ts, lib/supabaseAdmin.ts, lib/stockMaster.ts를 순수 Node
 * 스크립트에서도 그대로 재사용하기 위해 "react-server" 조건으로 실행해야 한다:
 *   tsx --conditions=react-server scripts/screen-all-stocks.ts
 * (package.json의 screen:all-stocks 스크립트가 이 플래그를 포함한다.)
 *
 * 필요 환경변수: KIS_APP_KEY, KIS_APP_SECRET, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getDailyPrices, getStockPrice } from "@/lib/kis";
import { getAllStocks } from "@/lib/stockMaster";
import {
  computeEntryPlan,
  evaluateTrackingStatus,
  matchesToday,
  type DailyPrice,
  type StrategyRule,
} from "@/lib/backtest";

// 스크리닝은 조건 판정만 하면 되므로 차트용 최대치(500건)가 아니라 필요 최소한만 가져온다.
// 미너비니 템플릿은 250거래일 신고/신저가 조건 때문에 250~300건이 필요해 KIS 페이지당
// 한도(100건) 상 종목당 최대 3회 호출이 든다 — ma_cross만 등록돼 있다면 훨씬 적게 든다.
// getDailyPrices/kisFetch의 전역 큐가 호출 주체와 무관하게 모든 KIS 호출을 초당 제한 안에서
// 직렬화하므로(lib/kis.ts의 MIN_KIS_CALL_INTERVAL_MS), 호출 횟수가 늘어도 쓰로틀링 자체는
// 그대로 안전하게 동작한다 — 다만 총 소요 시간이 그만큼 늘어난다.
const DAILY_TARGET_ROWS_DEFAULT = 100;
const MINERVINI_DAILY_TARGET_ROWS = 300;

const CALL_RETRY_COUNT = 2;
const CALL_RETRY_DELAY_MS = 2000;
const PROGRESS_LOG_INTERVAL = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** kis.ts 내부적으로도 초당 제한(EGW00201)에 대한 재시도가 있지만, 그 외의 일시적 오류
 * (네트워크 오류, 게이트웨이 오류 등)까지 흡수하기 위한 한 겹 더 바깥의 재시도. */
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

type StrategyRow = StrategyRule & { id: string; name: string };

async function loadStrategies(): Promise<StrategyRow[]> {
  const { data, error } = await supabaseAdmin
    .from("strategies")
    .select("id, name, rule_type, rule_params");

  if (error) throw new Error(`전략 조회 실패: ${error.message}`);
  return (data ?? []) as StrategyRow[];
}

/**
 * 등록된 전략들이 필요로 하는 최대 일봉 건수를 계산한다. 종목당 한 번만 조회해서 모든
 * 전략 판정에 재사용하므로, 가장 많이 필요로 하는 전략 기준으로 한 번에 넉넉히 가져온다.
 */
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

interface ActiveRow {
  id: string;
  stock_code: string;
  entry_price: number;
  stop_loss_price: number;
  take_profit_price: number;
}

/** status=active인 기존 추적 종목의 현재가를 갱신하고, 손절/익절 조건에 걸리면 종료 처리한다. */
async function updateActiveTracking(): Promise<{
  updated: number;
  stopped: number;
  profited: number;
}> {
  console.log("=== 1단계: 기존 추적 종목 갱신 ===");

  const { data: activeRows, error } = await supabaseAdmin
    .from("screening_results")
    .select("id, stock_code, entry_price, stop_loss_price, take_profit_price")
    .eq("status", "active");

  if (error) throw new Error(`추적 종목 조회 실패: ${error.message}`);

  if (!activeRows || activeRows.length === 0) {
    console.log("추적 중인 종목이 없습니다.");
    return { updated: 0, stopped: 0, profited: 0 };
  }

  // 같은 종목이 여러 전략에서 동시에 active일 수 있으니 종목코드별로 현재가를 한 번만 조회한다.
  const uniqueCodes = Array.from(new Set(activeRows.map((r) => r.stock_code)));
  console.log(`추적 중인 종목 ${activeRows.length}건 (종목코드 기준 ${uniqueCodes.length}개)`);

  const priceByCode = new Map<string, number>();

  for (let i = 0; i < uniqueCodes.length; i++) {
    const code = uniqueCodes[i];
    console.log(`  [${i + 1}/${uniqueCodes.length}] ${code} 현재가 조회 중...`);

    try {
      const price = await withRetry(() => getStockPrice(code), `${code} 현재가 조회`);
      priceByCode.set(code, price.currentPrice);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`    ${code} 현재가 조회 실패, 이번 실행에서는 건너뜁니다: ${message}`);
    }
  }

  let updated = 0;
  let stopped = 0;
  let profited = 0;

  for (const row of activeRows as ActiveRow[]) {
    const currentPrice = priceByCode.get(row.stock_code);
    if (currentPrice === undefined) continue;

    const returnPct = ((currentPrice - row.entry_price) / row.entry_price) * 100;
    const status = evaluateTrackingStatus(
      currentPrice,
      row.stop_loss_price,
      row.take_profit_price
    );

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

/** 전종목을 스캔해 저장된 전략 조건을 새로 만족하는 종목을 screening_results에 추가한다. */
async function scanAllStocks(
  strategies: StrategyRow[]
): Promise<{ scanned: number; matched: number; errors: number }> {
  console.log("=== 2단계: 전종목 스캔 ===");

  if (strategies.length === 0) {
    console.log("등록된 전략이 없어 스캔을 건너뜁니다.");
    return { scanned: 0, matched: 0, errors: 0 };
  }

  const allStocks = await getAllStocks();
  const dailyTargetRows = computeDailyTargetRows(strategies);
  const callsPerStock = Math.ceil(dailyTargetRows / 100);
  console.log(
    `전략 ${strategies.length}개 × 대상 종목 ${allStocks.length}개, 종목당 일봉 ${dailyTargetRows}건(호출 ${callsPerStock}회) 조회`
  );

  // 이미 추적 중인 (전략, 종목) 쌍은 다시 추가하지 않는다.
  const { data: existingActive, error: activeError } = await supabaseAdmin
    .from("screening_results")
    .select("strategy_id, stock_code")
    .eq("status", "active");

  if (activeError) throw new Error(`추적 중인 종목 조회 실패: ${activeError.message}`);

  const activeKeys = new Set(
    (existingActive ?? []).map((r) => `${r.strategy_id}:${r.stock_code}`)
  );

  let matched = 0;
  let errors = 0;

  for (let i = 0; i < allStocks.length; i++) {
    const stock = allStocks[i];

    if (i === 0 || (i + 1) % PROGRESS_LOG_INTERVAL === 0 || i === allStocks.length - 1) {
      console.log(
        `  [${i + 1}/${allStocks.length}] 진행 중... (누적 매칭 ${matched}건, 오류 ${errors}건)`
      );
    }

    let prices: DailyPrice[];
    try {
      prices = await withRetry(
        () => getDailyPrices(stock.code, "D", dailyTargetRows),
        `${stock.code}(${stock.name}) 일봉 조회`
      );
    } catch (error) {
      errors++;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`    ${stock.code}(${stock.name}) 일봉 조회 실패, 건너뜁니다: ${message}`);
      continue;
    }

    if (prices.length === 0) continue;

    for (const strategy of strategies) {
      if (!matchesToday(prices, strategy)) continue;

      const key = `${strategy.id}:${stock.code}`;
      if (activeKeys.has(key)) continue; // 이미 추적 중

      const signalPrice = prices[prices.length - 1].close;
      const { entryPrice, stopLossPrice, takeProfitPrice } = computeEntryPlan(prices, strategy);

      const { error: insertError } = await supabaseAdmin.from("screening_results").insert({
        strategy_id: strategy.id,
        stock_code: stock.code,
        stock_name: stock.name,
        signal_price: signalPrice,
        entry_price: entryPrice,
        stop_loss_price: stopLossPrice,
        take_profit_price: takeProfitPrice,
        current_price: signalPrice,
        return_pct: 0,
        status: "active",
      });

      if (insertError) {
        console.error(`    ${stock.code} 저장 실패 (${strategy.name}): ${insertError.message}`);
        continue;
      }

      activeKeys.add(key); // 같은 실행 내 중복 방지
      matched++;
      console.log(
        `    ✓ 신규 매칭: ${stock.name}(${stock.code}) — ${strategy.name} (진입가 ${entryPrice.toLocaleString("ko-KR")})`
      );
    }
  }

  console.log(`스캔 완료: 신규 매칭 ${matched}건, 조회 실패 ${errors}건`);
  return { scanned: allStocks.length, matched, errors };
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
  console.log(`스크리닝 배치 시작: ${startedAt.toISOString()}`);

  const strategies = await loadStrategies();
  console.log(`등록된 전략 수: ${strategies.length}`);

  await updateActiveTracking();
  const { scanned, matched, errors } = await scanAllStocks(strategies);

  await recordRun(startedAt, scanned, matched, errors);

  const elapsedSec = ((Date.now() - startedAt.getTime()) / 1000).toFixed(1);
  console.log(`스크리닝 배치 종료: ${elapsedSec}초 소요`);
}

main().catch((error) => {
  console.error("배치 실행 중 오류가 발생했습니다:", error);
  process.exit(1);
});
