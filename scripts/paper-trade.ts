/**
 * "AI 모의투자" 배치 스크립트. screening.yml에서 screen:all-stocks 다음 스텝으로
 * 실행된다(추가 KIS 시세 호출 없음 — screening_results.current_price를 그대로 재사용).
 *
 * 매일 하는 일:
 * 1) 공격형/안정형 전략을 Claude로 재생성(어제 전략의 기간 성과를 참고 자료로 넘긴다)
 * 2) 두 가상 계좌의 보유 포지션을 새 전략의 청산조건으로 평가해 매도
 *    (원 스크리닝 신호가 이미 손절/익절로 종료됐으면 그 가격 그대로 함께 청산)
 * 3) 남은 현금/슬롯 한도 안에서 새 전략의 진입조건에 맞는 스크리닝 결과를 매수
 * 4) 계좌별 일별 평가금액 스냅샷 기록
 *
 * 필요 환경변수: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY
 *   tsx --conditions=react-server scripts/paper-trade.ts
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  generateStrategy,
  type PaperStrategyConditions,
  type PaperStyle,
  type PreviousStrategySummary,
} from "@/lib/paperStrategy";
import {
  computeEquity,
  evaluateExit,
  selectBuyCandidates,
  type ScreeningCandidateRow,
  type UnderlyingScreeningStatus,
} from "@/lib/paperTrading";

const STYLES: PaperStyle[] = ["aggressive", "conservative"];

function todayKstDate(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

interface PortfolioRow {
  id: string;
  style: PaperStyle;
  initial_capital: number;
  cash: number;
}

async function loadPortfolios(): Promise<PortfolioRow[]> {
  const { data, error } = await supabaseAdmin
    .from("paper_portfolios")
    .select("id, style, initial_capital, cash");
  if (error) throw new Error(`가상 계좌 조회 실패: ${error.message}`);
  if (!data || data.length !== STYLES.length) {
    throw new Error(
      `가상 계좌가 ${STYLES.length}개(스타일별 1개)여야 하는데 ${data?.length ?? 0}개입니다. 마이그레이션 시드를 확인하세요.`
    );
  }
  return data as PortfolioRow[];
}

/** 오늘 배치가 이미 실행됐는지 확인한다(같은 날 수동 재실행 시 이중 매매를 막는 안전장치). */
async function alreadyRanToday(): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("paper_runs")
    .select("finished_at")
    .order("finished_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`배치 실행 이력 조회 실패: ${error.message}`);
  if (!data) return false;

  const lastRunDate = new Date(data.finished_at).toLocaleDateString("en-CA", {
    timeZone: "Asia/Seoul",
  });
  return lastRunDate === todayKstDate();
}

interface ActiveStrategyRow {
  id: string;
  version: number;
  label: string;
  entry_conditions: PaperStrategyConditions["entry_conditions"];
  exit_conditions: PaperStrategyConditions["exit_conditions"];
  stock_selection_criteria: PaperStrategyConditions["stock_selection_criteria"];
  created_at: string;
}

async function loadActiveStrategy(style: PaperStyle): Promise<ActiveStrategyRow | null> {
  const { data, error } = await supabaseAdmin
    .from("paper_strategies")
    .select(
      "id, version, label, entry_conditions, exit_conditions, stock_selection_criteria, created_at"
    )
    .eq("style", style)
    .eq("is_active", true)
    .maybeSingle();
  if (error) throw new Error(`활성 전략 조회 실패(${style}): ${error.message}`);
  return data as ActiveStrategyRow | null;
}

/** 직전 전략이 살아있던 기간의 기간 수익률을 일별 스냅샷으로 근사한다. 스냅샷이
 * 아직 없으면(예: 첫 실행 다음 날) 0으로 처리한다 — 참고 자료일 뿐 매매 판단에는
 * 쓰이지 않으므로 근사치로 충분하다. */
async function summarizePreviousStrategy(
  portfolioId: string,
  previous: ActiveStrategyRow
): Promise<PreviousStrategySummary> {
  const createdDate = new Date(previous.created_at).toLocaleDateString("en-CA", {
    timeZone: "Asia/Seoul",
  });

  const { data: snapshots, error } = await supabaseAdmin
    .from("paper_daily_snapshots")
    .select("snapshot_date, equity")
    .eq("portfolio_id", portfolioId)
    .gte("snapshot_date", createdDate)
    .order("snapshot_date", { ascending: true });
  if (error) throw new Error(`일별 스냅샷 조회 실패: ${error.message}`);

  const first = snapshots?.[0];
  const last = snapshots?.[snapshots.length - 1];
  const periodReturnPct =
    first && last && first.equity > 0 ? ((last.equity - first.equity) / first.equity) * 100 : 0;

  const daysActive = Math.max(
    1,
    Math.round((Date.now() - new Date(previous.created_at).getTime()) / 86_400_000)
  );

  return {
    label: previous.label,
    conditions: {
      entry_conditions: previous.entry_conditions,
      exit_conditions: previous.exit_conditions,
      stock_selection_criteria: previous.stock_selection_criteria,
    },
    periodReturnPct,
    daysActive,
  };
}

/** 스타일별 전략을 재생성한다: 있던 활성 전략은 retired 처리하고 새 버전을 활성화한다. */
async function regenerateStrategy(
  style: PaperStyle,
  portfolioId: string,
  previousRow: ActiveStrategyRow | null
): Promise<ActiveStrategyRow> {
  const previousSummary = previousRow
    ? await summarizePreviousStrategy(portfolioId, previousRow)
    : null;

  const generated = await generateStrategy(style, previousSummary);

  if (previousRow) {
    const { error: retireError } = await supabaseAdmin
      .from("paper_strategies")
      .update({ is_active: false, retired_at: new Date().toISOString() })
      .eq("id", previousRow.id);
    if (retireError) throw new Error(`이전 전략 retire 실패(${style}): ${retireError.message}`);
  }

  const nextVersion = (previousRow?.version ?? 0) + 1;
  const { data: inserted, error: insertError } = await supabaseAdmin
    .from("paper_strategies")
    .insert({
      style,
      version: nextVersion,
      label: generated.conditions.label,
      entry_conditions: generated.conditions.entry_conditions,
      exit_conditions: generated.conditions.exit_conditions,
      stock_selection_criteria: generated.conditions.stock_selection_criteria,
      rationale: generated.conditions.rationale,
      model: generated.model,
      raw_response: generated.rawResponse,
    })
    .select(
      "id, version, label, entry_conditions, exit_conditions, stock_selection_criteria, created_at"
    )
    .single();
  if (insertError) throw new Error(`새 전략 저장 실패(${style}): ${insertError.message}`);

  console.log(`  [${style}] 전략 v${nextVersion} "${generated.conditions.label}" 생성 완료`);
  return inserted as ActiveStrategyRow;
}

function toConditions(row: ActiveStrategyRow): PaperStrategyConditions {
  return {
    label: row.label,
    rationale: "",
    entry_conditions: row.entry_conditions,
    exit_conditions: row.exit_conditions,
    stock_selection_criteria: row.stock_selection_criteria,
  };
}

async function loadCandidates(): Promise<ScreeningCandidateRow[]> {
  const { data: results, error } = await supabaseAdmin
    .from("screening_results")
    .select("id, stock_code, stock_name, strategy_id, return_pct, current_price")
    .eq("status", "active");
  if (error) throw new Error(`스크리닝 결과 조회 실패: ${error.message}`);
  if (!results || results.length === 0) return [];

  const strategyIds = Array.from(new Set(results.map((r) => r.strategy_id)));
  const { data: strategies, error: strategiesError } = await supabaseAdmin
    .from("strategies")
    .select("id, rule_type")
    .in("id", strategyIds);
  if (strategiesError) throw new Error(`전략 조회 실패: ${strategiesError.message}`);

  const ruleTypeById = new Map((strategies ?? []).map((s) => [s.id, s.rule_type]));

  return results
    .filter((r) => ruleTypeById.has(r.strategy_id))
    .map((r) => ({
      screeningResultId: r.id,
      stockCode: r.stock_code,
      stockName: r.stock_name,
      ruleType: ruleTypeById.get(r.strategy_id) as ScreeningCandidateRow["ruleType"],
      returnPct: r.return_pct,
      currentPrice: r.current_price,
    }));
}

interface PositionDbRow {
  id: string;
  portfolio_id: string;
  stock_code: string;
  stock_name: string;
  quantity: number;
  avg_price: number;
  opened_at: string;
  screening_result_id: string | null;
}

async function loadPositions(): Promise<PositionDbRow[]> {
  const { data, error } = await supabaseAdmin
    .from("paper_positions")
    .select("id, portfolio_id, stock_code, stock_name, quantity, avg_price, opened_at, screening_result_id");
  if (error) throw new Error(`보유 포지션 조회 실패: ${error.message}`);
  return (data ?? []) as PositionDbRow[];
}

/** 보유 포지션이 매달린 screening_results 원본 행의 현재 상태(활성/종료 여부, 현재가)를
 * 모은다. 후보 목록(활성 행)에 이미 있으면 재사용하고, 없으면(원본이 이미 종료된 경우)
 * 그 특정 행만 별도 조회한다 — 추가 KIS 호출 없이 DB 조회만 한다. */
async function loadUnderlyingStatuses(
  positions: PositionDbRow[],
  activeCandidates: ScreeningCandidateRow[]
): Promise<Map<string, UnderlyingScreeningStatus>> {
  const map = new Map<string, UnderlyingScreeningStatus>();
  for (const c of activeCandidates) {
    map.set(c.screeningResultId, { status: "active", currentPrice: c.currentPrice });
  }

  const missingIds = Array.from(
    new Set(
      positions
        .map((p) => p.screening_result_id)
        .filter((id): id is string => id !== null && !map.has(id))
    )
  );
  if (missingIds.length === 0) return map;

  const { data, error } = await supabaseAdmin
    .from("screening_results")
    .select("id, status, current_price")
    .in("id", missingIds);
  if (error) throw new Error(`청산 대상 원본 스크리닝 조회 실패: ${error.message}`);

  for (const row of data ?? []) {
    map.set(row.id, { status: row.status, currentPrice: row.current_price });
  }
  return map;
}

interface RunPortfolioResult {
  buyCount: number;
  sellCount: number;
}

async function runPortfolio(
  portfolio: PortfolioRow,
  strategyRow: ActiveStrategyRow,
  positions: PositionDbRow[],
  candidates: ScreeningCandidateRow[],
  underlyingByScreeningId: Map<string, UnderlyingScreeningStatus>,
  now: Date
): Promise<RunPortfolioResult> {
  const conditions = toConditions(strategyRow);
  const style = portfolio.style;

  let cash = portfolio.cash;
  let buyCount = 0;
  let sellCount = 0;
  const remainingPositions: PositionDbRow[] = [];

  // 1) 청산 판단
  for (const position of positions) {
    const underlying = position.screening_result_id
      ? (underlyingByScreeningId.get(position.screening_result_id) ?? null)
      : null;
    const decision = evaluateExit(
      style,
      conditions,
      {
        id: position.id,
        stockCode: position.stock_code,
        stockName: position.stock_name,
        quantity: position.quantity,
        avgPrice: position.avg_price,
        openedAt: position.opened_at,
        screeningResultId: position.screening_result_id,
      },
      underlying,
      now
    );

    if (!decision) {
      remainingPositions.push(position);
      continue;
    }

    const amount = decision.price * position.quantity;
    const realizedPnl = (decision.price - position.avg_price) * position.quantity;

    const { error: tradeError } = await supabaseAdmin.from("paper_trades").insert({
      portfolio_id: portfolio.id,
      strategy_id: strategyRow.id,
      stock_code: position.stock_code,
      stock_name: position.stock_name,
      side: "sell",
      quantity: position.quantity,
      price: decision.price,
      amount,
      realized_pnl: realizedPnl,
      rationale: decision.rationale,
      screening_result_id: position.screening_result_id,
    });
    if (tradeError) {
      console.error(`    [${style}] ${position.stock_code} 매도 기록 실패: ${tradeError.message}`);
      remainingPositions.push(position);
      continue;
    }

    const { error: deleteError } = await supabaseAdmin
      .from("paper_positions")
      .delete()
      .eq("id", position.id);
    if (deleteError) {
      console.error(`    [${style}] ${position.stock_code} 포지션 삭제 실패: ${deleteError.message}`);
    }

    cash += amount;
    sellCount++;
    console.log(`    [${style}] ✕ 매도 ${position.stock_name}(${position.stock_code}) ${position.quantity}주 @${decision.price}`);
  }

  // 2) 매수 판단
  const heldStockCodes = new Set(remainingPositions.map((p) => p.stock_code));
  const buyDecisions = selectBuyCandidates(
    style,
    conditions,
    candidates,
    heldStockCodes,
    remainingPositions.length,
    cash
  );

  for (const decision of buyDecisions) {
    const { error: tradeError } = await supabaseAdmin.from("paper_trades").insert({
      portfolio_id: portfolio.id,
      strategy_id: strategyRow.id,
      stock_code: decision.candidate.stockCode,
      stock_name: decision.candidate.stockName,
      side: "buy",
      quantity: decision.quantity,
      price: decision.candidate.currentPrice,
      amount: decision.amount,
      rationale: decision.rationale,
      screening_result_id: decision.candidate.screeningResultId,
    });
    if (tradeError) {
      console.error(`    [${style}] ${decision.candidate.stockCode} 매수 기록 실패: ${tradeError.message}`);
      continue;
    }

    const { error: positionError } = await supabaseAdmin.from("paper_positions").insert({
      portfolio_id: portfolio.id,
      stock_code: decision.candidate.stockCode,
      stock_name: decision.candidate.stockName,
      quantity: decision.quantity,
      avg_price: decision.candidate.currentPrice,
      screening_result_id: decision.candidate.screeningResultId,
      opened_strategy_id: strategyRow.id,
    });
    if (positionError) {
      console.error(`    [${style}] ${decision.candidate.stockCode} 포지션 저장 실패: ${positionError.message}`);
      continue;
    }

    cash -= decision.amount;
    buyCount++;
    console.log(`    [${style}] ✓ 매수 ${decision.candidate.stockName}(${decision.candidate.stockCode}) ${decision.quantity}주 @${decision.candidate.currentPrice}`);
  }

  // 3) 평가금액 계산 및 스냅샷/현금 반영
  const heldAfter = [
    ...remainingPositions.map((p) => ({
      code: p.stock_code,
      quantity: p.quantity,
      price: underlyingByScreeningId.get(p.screening_result_id ?? "")?.currentPrice ?? p.avg_price,
    })),
    ...buyDecisions.map((d) => ({
      code: d.candidate.stockCode,
      quantity: d.quantity,
      price: d.candidate.currentPrice,
    })),
  ];
  const holdingsValue = heldAfter.reduce((sum, h) => sum + h.quantity * h.price, 0);
  const { equity } = computeEquity(cash, holdingsValue);

  const { error: cashError } = await supabaseAdmin
    .from("paper_portfolios")
    .update({ cash })
    .eq("id", portfolio.id);
  if (cashError) throw new Error(`계좌 현금 갱신 실패(${style}): ${cashError.message}`);

  await recordSnapshot(portfolio, cash, holdingsValue, equity);

  return { buyCount, sellCount };
}

async function recordSnapshot(
  portfolio: PortfolioRow,
  cash: number,
  holdingsValue: number,
  equity: number
): Promise<void> {
  const { data: prevSnapshot, error: prevError } = await supabaseAdmin
    .from("paper_daily_snapshots")
    .select("equity")
    .eq("portfolio_id", portfolio.id)
    .order("snapshot_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (prevError) throw new Error(`이전 스냅샷 조회 실패: ${prevError.message}`);

  const baseline = prevSnapshot?.equity ?? portfolio.initial_capital;
  const dailyReturnPct = baseline > 0 ? ((equity - baseline) / baseline) * 100 : 0;
  const cumulativeReturnPct =
    portfolio.initial_capital > 0
      ? ((equity - portfolio.initial_capital) / portfolio.initial_capital) * 100
      : 0;

  const { error } = await supabaseAdmin.from("paper_daily_snapshots").upsert(
    {
      portfolio_id: portfolio.id,
      snapshot_date: todayKstDate(),
      cash,
      holdings_value: holdingsValue,
      equity,
      daily_return_pct: dailyReturnPct,
      cumulative_return_pct: cumulativeReturnPct,
    },
    { onConflict: "portfolio_id,snapshot_date" }
  );
  if (error) throw new Error(`일별 스냅샷 저장 실패: ${error.message}`);
}

async function recordRun(startedAt: Date, buyCount: number, sellCount: number, errorCount: number): Promise<void> {
  const { error } = await supabaseAdmin.from("paper_runs").insert({
    started_at: startedAt.toISOString(),
    finished_at: new Date().toISOString(),
    buy_count: buyCount,
    sell_count: sellCount,
    error_count: errorCount,
  });
  if (error) console.error(`배치 실행 기록 저장 실패: ${error.message}`);
}

async function main(): Promise<void> {
  const startedAt = new Date();
  console.log(`AI 모의투자 배치 시작: ${startedAt.toISOString()}`);

  if (await alreadyRanToday()) {
    console.log("오늘 이미 실행된 기록이 있어 건너뜁니다(중복 매매 방지).");
    return;
  }

  const portfolios = await loadPortfolios();

  console.log("=== 1단계: 전략 재생성 ===");
  const strategyByStyle = new Map<PaperStyle, ActiveStrategyRow>();
  for (const style of STYLES) {
    const portfolio = portfolios.find((p) => p.style === style)!;
    const previous = await loadActiveStrategy(style);
    const strategy = await regenerateStrategy(style, portfolio.id, previous);
    strategyByStyle.set(style, strategy);
  }

  console.log("=== 2단계: 매매 판단 ===");
  const candidates = await loadCandidates();
  console.log(`  매수 후보(활성 스크리닝 결과): ${candidates.length}건`);
  const allPositions = await loadPositions();
  const underlyingByScreeningId = await loadUnderlyingStatuses(allPositions, candidates);

  let totalBuy = 0;
  let totalSell = 0;
  let errorCount = 0;
  const now = new Date();

  for (const portfolio of portfolios) {
    const strategyRow = strategyByStyle.get(portfolio.style)!;
    const positions = allPositions.filter((p) => p.portfolio_id === portfolio.id);
    try {
      const { buyCount, sellCount } = await runPortfolio(
        portfolio,
        strategyRow,
        positions,
        candidates,
        underlyingByScreeningId,
        now
      );
      totalBuy += buyCount;
      totalSell += sellCount;
    } catch (error) {
      errorCount++;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  [${portfolio.style}] 처리 중 오류: ${message}`);
    }
  }

  await recordRun(startedAt, totalBuy, totalSell, errorCount);

  const elapsedSec = ((Date.now() - startedAt.getTime()) / 1000).toFixed(1);
  console.log(
    `AI 모의투자 배치 종료: ${elapsedSec}초 소요 (매수 ${totalBuy}건, 매도 ${totalSell}건, 오류 ${errorCount}건)`
  );
}

main().catch((error) => {
  console.error("AI 모의투자 배치 실행 중 오류가 발생했습니다:", error);
  process.exit(1);
});
