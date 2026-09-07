/**
 * 1회성 데이터 보정 스크립트(실제 프로덕션 screening_results를 수정한다, 읽기 전용
 * 아님) — 2026-09-07 발견된 버그(lib/backtest.ts의 computeReversalBreakoutEntryPrice가
 * reversal_breakout/reversal_breakout_v2의 entry_price를 minervini_trend_template/
 * custom_composite와 같은 방식(최근 20거래일 고점)으로 계산해 옴) 때문에, 잘못된
 * entry_price 기준으로 이미 손절(stopped)/익절(profited) 처리된 행들을 올바른 기준
 * (entry_price = signal_price)으로 실제 일별 시세를 다시 재생해 정확한
 * status/return_pct/closed_at으로 되돌린다.
 *
 * supabase/migrations/20260907000000_fix_reversal_breakout_live_tracking_entry_price.sql은
 * status='active'인 행만 SQL로 보정한다 — closed(stopped/profited) 행은 그 사이의
 * 일별 시세를 순회해야 정확한 청산일을 찾을 수 있어 SQL만으로는 부족하다. 이 스크립트가
 * 그 나머지(v1 reversal_breakout 약 180건 + v2 존재 시 함께)를 처리한다.
 *
 * 판정 로직은 lib/backtest.ts의 evaluateTrackingStatus를 그대로 재사용한다(직접
 * 재구현하지 않음 — 라이브 배치의 실제 판정 방식과 100% 동일해야 하기 때문이다).
 *
 * 필요 환경변수: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   tsx --conditions=react-server scripts/replay-reversal-breakout-closed-results.ts
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getDailyPriceSeries } from "@/lib/stockDailyPricesStorage";
import { evaluateTrackingStatus, DEFAULT_STOP_LOSS_PCT, DEFAULT_TAKE_PROFIT_PCT, type TrackingStatus } from "@/lib/backtest";

const REVERSAL_BREAKOUT_RULE_TYPES = ["reversal_breakout", "reversal_breakout_v2"] as const;

interface StrategyRow {
  id: string;
  rule_params: { stop_loss_pct?: number; take_profit_pct?: number };
}

interface ClosedResultRow {
  id: string;
  strategy_id: string;
  stock_code: string;
  signal_price: number;
  matched_at: string;
  closed_at: string | null;
  status: TrackingStatus;
  return_pct: number;
}

function toDateKey(iso: string): string {
  return iso.slice(0, 10);
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function loadReversalBreakoutStrategies(): Promise<Map<string, StrategyRow>> {
  const { data, error } = await supabaseAdmin
    .from("strategies")
    .select("id, rule_params")
    .in("rule_type", REVERSAL_BREAKOUT_RULE_TYPES);
  if (error) throw new Error(`전략 조회 실패: ${error.message}`);

  const map = new Map<string, StrategyRow>();
  for (const row of data ?? []) {
    map.set(row.id, row as StrategyRow);
  }
  return map;
}

async function loadClosedResults(strategyIds: string[]): Promise<ClosedResultRow[]> {
  if (strategyIds.length === 0) return [];

  const { data, error } = await supabaseAdmin
    .from("screening_results")
    .select("id, strategy_id, stock_code, signal_price, matched_at, closed_at, status, return_pct")
    .in("strategy_id", strategyIds)
    .in("status", ["stopped", "profited"]);
  if (error) throw new Error(`closed screening_results 조회 실패: ${error.message}`);

  return (data ?? []) as ClosedResultRow[];
}

interface ReplayOutcome {
  status: TrackingStatus;
  closedAt: string | null;
  currentPrice: number;
  returnPct: number;
  entryPrice: number;
  stopLossPrice: number;
  takeProfitPrice: number;
  reopened: boolean;
}

/** matched_at 다음날부터 오늘까지 일별 종가를 재생해, 올바른 기준(entryPrice=signalPrice)
 * 으로 손절/익절이 실제로 발생했는지 다시 판정한다. 못 찾으면(끝까지 active) 재오픈. */
function replayOutcome(
  signalPrice: number,
  stopPct: number,
  takePct: number,
  series: { tradeDate: string; closePrice: number }[]
): ReplayOutcome {
  const stopLossPrice = signalPrice * (1 - stopPct);
  const takeProfitPrice = signalPrice * (1 + takePct);

  for (const row of series) {
    const status = evaluateTrackingStatus(row.closePrice, stopLossPrice, takeProfitPrice);
    if (status !== "active") {
      return {
        status,
        closedAt: `${row.tradeDate}T00:00:00.000Z`,
        currentPrice: row.closePrice,
        returnPct: ((row.closePrice - signalPrice) / signalPrice) * 100,
        entryPrice: signalPrice,
        stopLossPrice,
        takeProfitPrice,
        reopened: false,
      };
    }
  }

  // 끝까지(오늘까지) 손절/익절 조건에 닿지 않았다 — 원래라면 아직 열려 있어야 하는
  // 신호이므로 active로 되돌린다(재오픈). 가장 최근 종가로 current_price/return_pct를 갱신한다.
  const last = series[series.length - 1];
  const currentPrice = last ? last.closePrice : signalPrice;
  return {
    status: "active",
    closedAt: null,
    currentPrice,
    returnPct: ((currentPrice - signalPrice) / signalPrice) * 100,
    entryPrice: signalPrice,
    stopLossPrice,
    takeProfitPrice,
    reopened: true,
  };
}

async function main(): Promise<void> {
  const strategyById = await loadReversalBreakoutStrategies();
  const strategyIds = Array.from(strategyById.keys());
  console.log(`reversal_breakout/reversal_breakout_v2 전략 ${strategyIds.length}개 확인`);

  const closedResults = await loadClosedResults(strategyIds);
  console.log(`재생 대상(status in stopped/profited) ${closedResults.length}건`);

  const today = new Date().toISOString().slice(0, 10);

  let updated = 0;
  let reopened = 0;
  let skipped = 0;
  let unchanged = 0;

  for (const row of closedResults) {
    const strategy = strategyById.get(row.strategy_id);
    const stopPct = strategy?.rule_params.stop_loss_pct ?? DEFAULT_STOP_LOSS_PCT;
    const takePct = strategy?.rule_params.take_profit_pct ?? DEFAULT_TAKE_PROFIT_PCT;

    const startDate = addDays(toDateKey(row.matched_at), 1);
    let series;
    try {
      series = await getDailyPriceSeries(row.stock_code, startDate, today);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  [스킵] ${row.stock_code}(${row.id}) 시세 조회 실패: ${message}`);
      skipped++;
      continue;
    }

    if (series.length === 0) {
      console.error(
        `  [스킵] ${row.stock_code}(${row.id}) ${startDate}~${today} 구간 일봉 데이터 없음(상장폐지/데이터 누락 가능) — 수정하지 않음`
      );
      skipped++;
      continue;
    }

    const outcome = replayOutcome(row.signal_price, stopPct, takePct, series);

    const { error: updateError } = await supabaseAdmin
      .from("screening_results")
      .update({
        entry_price: outcome.entryPrice,
        stop_loss_price: outcome.stopLossPrice,
        take_profit_price: outcome.takeProfitPrice,
        current_price: outcome.currentPrice,
        return_pct: outcome.returnPct,
        status: outcome.status,
        closed_at: outcome.closedAt,
      })
      .eq("id", row.id);

    if (updateError) {
      console.error(`  [스킵] ${row.stock_code}(${row.id}) 갱신 실패: ${updateError.message}`);
      skipped++;
      continue;
    }

    if (outcome.reopened) {
      reopened++;
      console.log(
        `  ${row.stock_code}: ${row.status}(${row.return_pct.toFixed(2)}%) → active(재오픈, ${outcome.returnPct.toFixed(2)}%)`
      );
    } else if (outcome.status === row.status) {
      unchanged++;
      console.log(
        `  ${row.stock_code}: ${row.status}(${row.return_pct.toFixed(2)}%) → ${outcome.status}(${outcome.returnPct.toFixed(2)}%) (상태 동일, 수익률만 보정)`
      );
    } else {
      console.log(
        `  ${row.stock_code}: ${row.status}(${row.return_pct.toFixed(2)}%) → ${outcome.status}(${outcome.returnPct.toFixed(2)}%)`
      );
    }
    updated++;
  }

  console.log(
    `\n=== 완료: 갱신 ${updated}건(그중 재오픈 ${reopened}건, 상태 동일 ${unchanged}건), 스킵 ${skipped}건 ===`
  );
}

main().catch((error) => {
  console.error("리플레이 스크립트 실행 중 오류:", error);
  process.exit(1);
});
