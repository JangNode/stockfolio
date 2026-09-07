/**
 * 읽기 전용 조사 스크립트 — 아무것도 수정하지 않는다. 2026-09-07 발견된
 * reversal_breakout/reversal_breakout_v2 entry_price 버그(lib/backtest.ts의
 * computeReversalBreakoutEntryPrice가 잘못된 진입가를 계산해 온 문제)가 AI 모의투자
 * "급등주"(style='surge_stock', supabase/migrations/20260831030000_seed_surge_stock_paper_style.sql
 * 참고 — entry_conditions.source_rule_types에 reversal_breakout만 지정돼 있다)에도
 * 영향을 줬는지 확인한다.
 *
 * lib/paperTrading.ts의 evaluateExit는 원 스크리닝 신호가 손절/익절로 종료되면(원
 * 배치가 이미 판단한 status/current_price를 그대로 재사용) 모의투자 포지션도 강제로
 * 함께 청산한다(rationale: "[...] 원 스크리닝 신호가 (손절|익절)로 종료되어 포지션도
 * 함께 청산."). 이 스크립트는 그 강제청산 매매 중 원 screening_results.strategy_id가
 * reversal_breakout/reversal_breakout_v2인 것만 골라 realized_pnl 합계를 보고한다.
 *
 * 필요 환경변수: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   tsx --conditions=react-server scripts/diagnose-surge-stock-bug-impact.ts
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";

const REVERSAL_BREAKOUT_RULE_TYPES = ["reversal_breakout", "reversal_breakout_v2"] as const;
const FORCED_EXIT_RATIONALE_MARKERS = ["원 스크리닝 신호가", "종료되어 포지션도 함께 청산"] as const;

interface PaperTradeRow {
  id: string;
  screening_result_id: string | null;
  realized_pnl: number | null;
  traded_at: string;
  rationale: string;
  stock_code: string;
  stock_name: string;
}

async function loadSurgeStockPaperStrategyIds(): Promise<string[]> {
  const { data, error } = await supabaseAdmin.from("paper_strategies").select("id, style").eq("style", "surge_stock");
  if (error) throw new Error(`paper_strategies 조회 실패: ${error.message}`);
  return (data ?? []).map((row) => row.id as string);
}

async function loadForcedExitTrades(strategyIds: string[]): Promise<PaperTradeRow[]> {
  if (strategyIds.length === 0) return [];

  // rationale에 두 문구를 모두 포함한 매도 매매만 강제청산 분기로 발생한 것이다.
  const { data, error } = await supabaseAdmin
    .from("paper_trades")
    .select("id, screening_result_id, realized_pnl, traded_at, rationale, stock_code, stock_name")
    .eq("side", "sell")
    .in("strategy_id", strategyIds)
    .ilike("rationale", `%${FORCED_EXIT_RATIONALE_MARKERS[0]}%`)
    .ilike("rationale", `%${FORCED_EXIT_RATIONALE_MARKERS[1]}%`);
  if (error) throw new Error(`paper_trades 조회 실패: ${error.message}`);

  return (data ?? []) as PaperTradeRow[];
}

/** screening_result_id → 그 신호를 만든 전략의 rule_type. screen-all-stocks.ts의
 * loadStrategies와 같은 방식으로 두 테이블을 각각 조회해 애플리케이션에서 맵으로
 * 합친다(임베드 조인 문법 대신 이 코드베이스의 기존 패턴을 따른다). */
async function loadScreeningResultRuleTypes(screeningResultIds: string[]): Promise<Map<string, string>> {
  if (screeningResultIds.length === 0) return new Map();

  const { data: screeningResults, error: screeningError } = await supabaseAdmin
    .from("screening_results")
    .select("id, strategy_id")
    .in("id", screeningResultIds);
  if (screeningError) throw new Error(`screening_results 조회 실패: ${screeningError.message}`);

  const strategyIds = Array.from(new Set((screeningResults ?? []).map((r) => r.strategy_id as string)));
  if (strategyIds.length === 0) return new Map();

  const { data: strategies, error: strategiesError } = await supabaseAdmin
    .from("strategies")
    .select("id, rule_type")
    .in("id", strategyIds);
  if (strategiesError) throw new Error(`strategies 조회 실패: ${strategiesError.message}`);

  const ruleTypeByStrategyId = new Map<string, string>();
  for (const s of strategies ?? []) ruleTypeByStrategyId.set(s.id as string, s.rule_type as string);

  const map = new Map<string, string>();
  for (const r of screeningResults ?? []) {
    const ruleType = ruleTypeByStrategyId.get(r.strategy_id as string);
    if (ruleType) map.set(r.id as string, ruleType);
  }
  return map;
}

async function main(): Promise<void> {
  const surgeStockStrategyIds = await loadSurgeStockPaperStrategyIds();
  console.log(`paper_strategies(style='surge_stock') ${surgeStockStrategyIds.length}건: ${surgeStockStrategyIds.join(", ")}`);

  const forcedExitTrades = await loadForcedExitTrades(surgeStockStrategyIds);
  console.log(`강제청산 매도 매매(rationale 기준) 총 ${forcedExitTrades.length}건`);

  const screeningResultIds = Array.from(
    new Set(forcedExitTrades.map((t) => t.screening_result_id).filter((id): id is string => id !== null))
  );
  const ruleTypeById = await loadScreeningResultRuleTypes(screeningResultIds);

  const affected = forcedExitTrades.filter((t) => {
    const ruleType = t.screening_result_id ? ruleTypeById.get(t.screening_result_id) : undefined;
    return ruleType !== undefined && (REVERSAL_BREAKOUT_RULE_TYPES as readonly string[]).includes(ruleType);
  });

  console.log(
    `\n########## reversal_breakout/reversal_breakout_v2 원인 강제청산 매매: ${affected.length}건 ##########`
  );

  let profitSum = 0;
  let lossSum = 0;

  for (const trade of affected) {
    const pnl = trade.realized_pnl ?? 0;
    if (pnl >= 0) profitSum += pnl;
    else lossSum += pnl;

    console.log(
      `  ${trade.traded_at} ${trade.stock_name}(${trade.stock_code}) realized_pnl=${pnl.toLocaleString("ko-KR")} — ${trade.rationale}`
    );
  }

  console.log(`\n=== 요약: ${affected.length}건, 이익 합계 ${profitSum.toLocaleString("ko-KR")}, 손실 합계 ${lossSum.toLocaleString("ko-KR")}, 순합계 ${(profitSum + lossSum).toLocaleString("ko-KR")} ===`);
}

main().catch((error) => {
  console.error("조사 스크립트 실행 중 오류:", error);
  process.exit(1);
});
