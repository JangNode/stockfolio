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
 * 2026-09-07 2차 수정: 1차 실행 결과 같은 (strategy_id, stock_code) 쌍에 과거 여러
 * 시점의 신호(에피소드)가 있는 경우, 각 closed 행을 독립적으로 "매칭일 다음날부터
 * 오늘까지" 재생하면 여러 에피소드가 동시에 "끝까지 못 찾음 → active로 재오픈"을
 * 시도해 (strategy_id, stock_code)당 active 1개만 허용하는 유니크 인덱스
 * (screening_results_active_unique_idx)에 충돌한다. 이를 막기 위해 종목×전략별로
 * 전체 이력(status 무관)을 matched_at 오름차순으로 묶어, 각 에피소드의 재생 구간을
 * "다음 에피소드의 matched_at 하루 전"까지로 제한한다 — 다음 신호가 이미 발생했다는
 * 것 자체가 이 에피소드는 그 이전에 이미 종료됐어야 한다는 뜻이기 때문이다. 그룹의
 * 마지막 에피소드만 재생 구간이 "오늘까지"이고, 끝까지 못 찾으면 active로 재오픈한다.
 * 마지막이 아닌 에피소드가 구간 끝까지 손절/익절 임계값에 닿지 않으면(다음 신호
 * 시작 직전까지도 애매하게 끝난 경우), active로 만들 수는 없으므로 구간 마지막 날
 * 종가 기준 손익 부호로 stopped/profited를 근사 확정한다(로그에 근사치임을 표시).
 *
 * 필요 환경변수: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   tsx --conditions=react-server scripts/replay-reversal-breakout-closed-results.ts
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getDailyPriceSeries, getDailyPriceOnOrBefore } from "@/lib/stockDailyPricesStorage";
import { evaluateTrackingStatus, DEFAULT_STOP_LOSS_PCT, DEFAULT_TAKE_PROFIT_PCT, type TrackingStatus } from "@/lib/backtest";

const REVERSAL_BREAKOUT_RULE_TYPES = ["reversal_breakout", "reversal_breakout_v2"] as const;

interface StrategyRow {
  id: string;
  rule_params: { stop_loss_pct?: number; take_profit_pct?: number };
}

interface ScreeningResultRow {
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

/** status 무관 전체 이력을 가져온다 — 다음 에피소드의 경계를 알려면 active 행도 봐야 한다. */
async function loadAllResults(strategyIds: string[]): Promise<ScreeningResultRow[]> {
  if (strategyIds.length === 0) return [];

  const { data, error } = await supabaseAdmin
    .from("screening_results")
    .select("id, strategy_id, stock_code, signal_price, matched_at, closed_at, status, return_pct")
    .in("strategy_id", strategyIds);
  if (error) throw new Error(`screening_results 조회 실패: ${error.message}`);

  return (data ?? []) as ScreeningResultRow[];
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
  approximated: boolean;
}

/** startDate~endDate 구간의 일별 종가를 재생해, 올바른 기준(entryPrice=signalPrice)으로
 * 손절/익절이 실제로 발생했는지 판정한다. isLastEpisode가 true면 구간 끝까지 못 찾을 때
 * active로 재오픈한다. false면(다음 에피소드가 이미 있어 active로 만들 수 없음) 구간
 * 마지막 날 종가의 손익 부호로 stopped/profited를 근사 확정한다. */
async function replayOutcome(
  stockCode: string,
  signalPrice: number,
  stopPct: number,
  takePct: number,
  startDate: string,
  endDate: string,
  isLastEpisode: boolean
): Promise<ReplayOutcome | null> {
  const stopLossPrice = signalPrice * (1 - stopPct);
  const takeProfitPrice = signalPrice * (1 + takePct);

  const series = startDate <= endDate ? await getDailyPriceSeries(stockCode, startDate, endDate) : [];

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
        approximated: false,
      };
    }
  }

  if (isLastEpisode) {
    // 구간에 시세가 하나도 없으면(오늘 장이 아직 안 끝났거나 데이터 파이프라인이 아직
    // 안 채워짐) 근거 없이 재오픈하지 않고 건너뛴다 — 나중에 데이터가 채워지면 재실행해서
    // 처리한다.
    if (series.length === 0) return null;

    // 끝까지(오늘까지) 손절/익절 조건에 닿지 않았다 — 원래라면 아직 열려 있어야 하는
    // 신호이므로 active로 되돌린다(재오픈). 가장 최근 종가로 current_price/return_pct를 갱신한다.
    const last = series[series.length - 1];
    return {
      status: "active",
      closedAt: null,
      currentPrice: last.closePrice,
      returnPct: ((last.closePrice - signalPrice) / signalPrice) * 100,
      entryPrice: signalPrice,
      stopLossPrice,
      takeProfitPrice,
      reopened: true,
      approximated: false,
    };
  }

  // 마지막 에피소드가 아닌데 구간 끝까지 임계값에 안 닿았다 — 다음 신호가 이미 발생했다는
  // 사실 자체가 이 에피소드는 그 이전에 이미 종료됐어야 한다는 뜻이므로 active로 둘 수
  // 없다. 구간 마지막 날(없으면 endDate 이전 가장 가까운 거래일) 종가의 손익 부호로
  // stopped/profited를 근사 확정한다.
  const last = series[series.length - 1] ?? (await getDailyPriceOnOrBefore(stockCode, endDate));
  if (!last) return null;

  const returnPct = ((last.closePrice - signalPrice) / signalPrice) * 100;
  return {
    status: returnPct >= 0 ? "profited" : "stopped",
    closedAt: `${last.tradeDate}T00:00:00.000Z`,
    currentPrice: last.closePrice,
    returnPct,
    entryPrice: signalPrice,
    stopLossPrice,
    takeProfitPrice,
    reopened: false,
    approximated: true,
  };
}

async function main(): Promise<void> {
  const strategyById = await loadReversalBreakoutStrategies();
  const strategyIds = Array.from(strategyById.keys());
  console.log(`reversal_breakout/reversal_breakout_v2 전략 ${strategyIds.length}개 확인`);

  const allResults = await loadAllResults(strategyIds);
  const closedCount = allResults.filter((r) => r.status !== "active").length;
  console.log(`전체 ${allResults.length}건 중 재생 대상(status in stopped/profited) ${closedCount}건`);

  const today = new Date().toISOString().slice(0, 10);

  // (strategy_id, stock_code)별로 묶어 matched_at 오름차순 정렬 — 에피소드 순서를 알아야
  // 각 에피소드의 재생 구간(다음 에피소드 시작 직전까지)을 정할 수 있다.
  const groups = new Map<string, ScreeningResultRow[]>();
  for (const row of allResults) {
    const key = `${row.strategy_id}:${row.stock_code}`;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => a.matched_at.localeCompare(b.matched_at));
  }

  let updated = 0;
  let reopened = 0;
  let unchanged = 0;
  let approximated = 0;
  let skipped = 0;

  for (const list of groups.values()) {
    for (let i = 0; i < list.length; i++) {
      const row = list[i];
      if (row.status === "active") continue; // active 행은 마이그레이션이 이미 보정했다 — 참고만 하고 갱신 대상에서 제외

      const strategy = strategyById.get(row.strategy_id);
      const stopPct = strategy?.rule_params.stop_loss_pct ?? DEFAULT_STOP_LOSS_PCT;
      const takePct = strategy?.rule_params.take_profit_pct ?? DEFAULT_TAKE_PROFIT_PCT;

      const next = list[i + 1];
      const isLastEpisode = !next;
      const startDate = addDays(toDateKey(row.matched_at), 1);
      const endDate = isLastEpisode ? today : addDays(toDateKey(next.matched_at), -1);

      let outcome: ReplayOutcome | null;
      try {
        outcome = await replayOutcome(row.stock_code, row.signal_price, stopPct, takePct, startDate, endDate, isLastEpisode);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`  [스킵] ${row.stock_code}(${row.id}) 시세 조회 실패: ${message}`);
        skipped++;
        continue;
      }

      if (!outcome) {
        console.error(
          `  [스킵] ${row.stock_code}(${row.id}) ${startDate}~${endDate} 구간 일봉 데이터 없음(상장폐지/데이터 누락 가능) — 수정하지 않음`
        );
        skipped++;
        continue;
      }

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

      const fromLabel = `${row.status}(${row.return_pct.toFixed(2)}%)`;
      if (outcome.reopened) {
        reopened++;
        console.log(`  ${row.stock_code}: ${fromLabel} → active(재오픈, ${outcome.returnPct.toFixed(2)}%)`);
      } else if (outcome.approximated) {
        approximated++;
        console.log(
          `  ${row.stock_code}: ${fromLabel} → ${outcome.status}(${outcome.returnPct.toFixed(2)}%) (다음 에피소드 시작으로 강제 종료, 근사치)`
        );
      } else if (outcome.status === row.status) {
        unchanged++;
        console.log(`  ${row.stock_code}: ${fromLabel} → ${outcome.status}(${outcome.returnPct.toFixed(2)}%) (상태 동일, 수익률만 보정)`);
      } else {
        console.log(`  ${row.stock_code}: ${fromLabel} → ${outcome.status}(${outcome.returnPct.toFixed(2)}%)`);
      }
      updated++;
    }
  }

  console.log(
    `\n=== 완료: 갱신 ${updated}건(재오픈 ${reopened}건, 근사확정 ${approximated}건, 상태 동일 ${unchanged}건), 스킵 ${skipped}건 ===`
  );
}

main().catch((error) => {
  console.error("리플레이 스크립트 실행 중 오류:", error);
  process.exit(1);
});
