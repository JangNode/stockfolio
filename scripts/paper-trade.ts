/**
 * "AI 모의투자" 배치 스크립트. 국내는 screening.yml에서 screen:all-stocks 다음
 * 스텝으로, 미국은 screening-us.yml에서 screen:us-stocks 다음 스텝으로 실행된다
 * (추가 KIS 시세 호출 없음 — screening_results.current_price를 그대로 재사용). 두
 * 스케줄의 실행 시각이 서로 달라(국내 KST 14:30, 미국 KST 04:00/05:00) 한 번 실행에
 * 한 시장만 처리한다 — PAPER_TRADE_MARKET 환경변수(KR|US, 필수)로 대상을 지정한다.
 *
 * 전략(JSON 조건)은 이 스크립트가 직접 생성하지 않는다. Anthropic API 과금 없이
 * 이미 쓰고 있는 Claude Code 접근을 재사용하기 위해, 별도 Routine(매일 KST 14:10)이
 * Claude Code 세션으로 data/paper-strategies/{style}.json을 lib/paperStrategy.ts의
 * PaperStrategyConditionsSchema에 맞춰 저장소에 직접 커밋해두고, 이 스크립트는 그
 * 파일을 읽기만 한다. 전략은 시장 무관하게 스타일별로 공유되므로(퍼센트/개수 기반
 * 조건이라 통화 단위가 없음) 어느 시장으로 실행되든 동일하게 반영을 시도한다 — 미국
 * 배치가 국내보다 먼저(라우틴이 도는 KST 14:10보다도 이전에) 도는 날엔 그날 아직
 * 갱신되지 않은 어제자 전략을 그대로 쓰고, 국내 배치가 그날 늦게 실행되며 새 버전을
 * 반영한다. 라우틴이 커밋 전 스스로 검증하는 데는 scripts/validate-paper-strategy.ts를
 * 쓴다.
 *
 * 매일 하는 일:
 * 1) data/paper-strategies/{style}.json이 오늘자로 갱신돼 있으면 새 전략 버전으로
 *    반영하고(기존 활성 버전은 retire), 없으면(라우틴 미실행/실패) 기존 활성 전략을
 *    그대로 유지한다 — 이 배치가 전략 없이 멈추는 일은 없다.
 * 2) 대상 시장 가상 계좌들의 보유 포지션을 전략의 청산조건으로 평가해 매도
 *    (원 스크리닝 신호가 이미 손절/익절로 종료됐으면 그 가격 그대로 함께 청산)
 * 3) 남은 현금/슬롯 한도 안에서 전략의 진입조건에 맞는 스크리닝 결과를 매수
 * 4) 계좌별 일별 평가금액 스냅샷 기록
 *
 * 필요 환경변수: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, PAPER_TRADE_MARKET(KR|US)
 *   PAPER_TRADE_MARKET=KR tsx --conditions=react-server scripts/paper-trade.ts
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadStrategyFile, type PaperStrategyConditions, type PaperStyle } from "@/lib/paperStrategy";
import type { Market } from "@/lib/market";
import { determineUsBatchSchedule } from "@/lib/usMarketCalendar";
import {
  computeEquity,
  evaluateExit,
  selectBuyCandidates,
  type ScreeningCandidateRow,
  type TradeConditions,
  type UnderlyingScreeningStatus,
} from "@/lib/paperTrading";

const STYLES: PaperStyle[] = ["aggressive", "conservative", "custom", "surge_stock"];
const MARKETS: Market[] = ["KR", "US"];

function parseTargetMarket(): Market {
  const raw = process.env.PAPER_TRADE_MARKET;
  if (raw === "KR" || raw === "US") return raw;
  throw new Error(
    `PAPER_TRADE_MARKET 환경변수가 KR 또는 US여야 하는데 "${raw ?? ""}"입니다. 워크플로 env 설정을 확인하세요.`
  );
}

function todayKstDate(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

interface PortfolioRow {
  id: string;
  style: PaperStyle;
  market: Market;
  initial_capital: number;
  cash: number;
}

async function loadPortfolios(): Promise<PortfolioRow[]> {
  const { data, error } = await supabaseAdmin
    .from("paper_portfolios")
    .select("id, style, market, initial_capital, cash");
  if (error) throw new Error(`가상 계좌 조회 실패: ${error.message}`);
  const expected = STYLES.length * MARKETS.length;
  if (!data || data.length !== expected) {
    throw new Error(
      `가상 계좌가 ${expected}개(스타일 x 시장별 1개)여야 하는데 ${data?.length ?? 0}개입니다. 마이그레이션 시드를 확인하세요.`
    );
  }
  return data as PortfolioRow[];
}

/** 오늘 이 시장의 배치가 이미 실행됐는지 확인한다(같은 날 수동 재실행 시 이중 매매를
 * 막는 안전장치). 국내/미국이 서로 다른 시각에 따로 실행되므로 시장별로 판단한다. */
async function alreadyRanToday(market: Market): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("paper_runs")
    .select("finished_at")
    .eq("market", market)
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

/**
 * data/paper-strategies/{style}.json(라우틴이 커밋)을 읽어 오늘자로 갱신돼 있으면
 * 새 전략 버전을 활성화하고, 아니면(라우틴 미실행/실패) 기존 활성 전략을 그대로
 * 반환한다. 활성 전략도 파일도 둘 다 없으면(첫 실행인데 라우틴도 아직 못 돈 경우)
 * null을 반환해 이 스타일은 이번 실행에서 매매를 건너뛰게 한다.
 */
async function determineStrategyForToday(
  style: PaperStyle,
  previousRow: ActiveStrategyRow | null
): Promise<ActiveStrategyRow | null> {
  const file = loadStrategyFile(style);

  if (!file) {
    if (previousRow) {
      console.warn(`  [${style}] 오늘자 전략 파일이 없어 기존 전략(v${previousRow.version})으로 계속 진행합니다.`);
      return previousRow;
    }
    console.error(`  [${style}] 전략 파일도 없고 기존 활성 전략도 없어 이 스타일은 이번 실행에서 건너뜁니다.`);
    return null;
  }

  const previousCreatedDate = previousRow
    ? new Date(previousRow.created_at).toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" })
    : null;
  const isNew = previousCreatedDate === null || file.generatedAtKstDate > previousCreatedDate;

  if (!isNew) {
    console.log(`  [${style}] 전략 파일이 이미 반영된 버전과 같아 재생성을 건너뜁니다(v${previousRow!.version} 유지).`);
    return previousRow;
  }

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
      label: file.conditions.label,
      entry_conditions: file.conditions.entry_conditions,
      exit_conditions: file.conditions.exit_conditions,
      stock_selection_criteria: file.conditions.stock_selection_criteria,
      rationale: file.conditions.rationale,
      model: "claude-code-routine",
      raw_response: null,
    })
    .select(
      "id, version, label, entry_conditions, exit_conditions, stock_selection_criteria, created_at"
    )
    .single();
  if (insertError) throw new Error(`새 전략 저장 실패(${style}): ${insertError.message}`);

  console.log(`  [${style}] 전략 v${nextVersion} "${file.conditions.label}" 반영 완료`);
  return inserted as ActiveStrategyRow;
}

function toConditions(row: ActiveStrategyRow): TradeConditions {
  return {
    entry_conditions: row.entry_conditions,
    exit_conditions: row.exit_conditions,
    stock_selection_criteria: row.stock_selection_criteria,
  };
}

async function loadCandidates(market: Market): Promise<ScreeningCandidateRow[]> {
  // 이번 실행의 대상 시장 스크리닝 결과만 조회한다. 각 후보에 market을 그대로
  // 태그해두는 건 이후 코드가 ScreeningCandidateRow 형태를 그대로 신뢰할 수 있게
  // 하기 위해서다(모든 후보가 이미 같은 시장이라 필터링이 실질적으로 더 필요하진 않다).
  const { data: results, error } = await supabaseAdmin
    .from("screening_results")
    .select("id, stock_code, stock_name, strategy_id, return_pct, current_price, market, exchange")
    .eq("status", "active")
    .eq("market", market);
  if (error) throw new Error(`스크리닝 결과 조회 실패: ${error.message}`);
  if (!results || results.length === 0) return [];

  const strategyIds = Array.from(new Set(results.map((r) => r.strategy_id)));
  const { data: strategies, error: strategiesError } = await supabaseAdmin
    .from("strategies")
    .select("id, rule_type")
    .in("id", strategyIds);
  if (strategiesError) throw new Error(`전략 조회 실패: ${strategiesError.message}`);

  const ruleTypeById = new Map((strategies ?? []).map((s) => [s.id, s.rule_type]));

  const mapped = results
    .filter((r) => ruleTypeById.has(r.strategy_id))
    .map((r) => ({
      screeningResultId: r.id,
      stockCode: r.stock_code,
      stockName: r.stock_name,
      ruleType: ruleTypeById.get(r.strategy_id) as ScreeningCandidateRow["ruleType"],
      returnPct: r.return_pct,
      currentPrice: r.current_price,
      market: r.market as Market,
      exchange: (r.exchange as string | null) ?? null,
    }));

  // dh_value_dividend/peg_lynch/reversal_breakout처럼 계정마다 한 행씩 시딩되는
  // rule_type(20260828030000_seed_dh_value_dividend_strategy.sql류 패턴)은 같은 종목이
  // strategy_id(=계정)만 다른 채로 screening_results에 여러 번 찍힌다. 이 함수 이후
  // 단계(selectBuyCandidates)는 후보를 종목 단위로 다루므로, 같은 종목을 중복으로
  // 넘기면 종목당 포지션을 한 번만 열 수 있는 paper_positions unique 제약과 충돌해
  // 두 번째 이후 매수 시도가 실패한다(2026-09-01 급등주 실행에서 실제 재현 — 004450/
  // 256840 포지션 저장 실패). 종목+rule_type 단위로 중복 제거한다 — 같은 종목이 서로
  // 다른 rule_type으로 매칭된 경우(예: minervini와 reversal_breakout 둘 다)는 별개
  // 신호이므로 그대로 남긴다.
  const seen = new Set<string>();
  const deduped: typeof mapped = [];
  for (const r of mapped) {
    const key = `${r.stockCode}:${r.ruleType}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(r);
  }
  return deduped;
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
  market: Market;
  exchange: string | null;
}

async function loadPositions(market: Market): Promise<PositionDbRow[]> {
  const { data, error } = await supabaseAdmin
    .from("paper_positions")
    .select(
      "id, portfolio_id, stock_code, stock_name, quantity, avg_price, opened_at, screening_result_id, market, exchange"
    )
    .eq("market", market);
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
        market: position.market,
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
      market: position.market,
      exchange: position.exchange,
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

  // 2) 매수 판단 (candidates는 이미 loadCandidates 단계에서 이번 실행의 대상 시장으로
  // 한정돼 있다)
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
      market: decision.candidate.market,
      exchange: decision.candidate.exchange,
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
      market: decision.candidate.market,
      exchange: decision.candidate.exchange,
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

async function recordRun(
  market: Market,
  startedAt: Date,
  buyCount: number,
  sellCount: number,
  errorCount: number
): Promise<void> {
  const { error } = await supabaseAdmin.from("paper_runs").insert({
    market,
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
  const market = parseTargetMarket();
  console.log(`AI 모의투자 배치 시작(대상 시장: ${market}): ${startedAt.toISOString()}`);

  // 미국 배치는 국내와 마찬가지로 pg_cron이 서머타임/표준시 두 잡을 매일 다 발화시킨다
  // (screening-us.yml과 같은 이유·같은 판별 함수). pg_cron이 넘긴 schedule_cron 입력이
  // 있을 때만 적용하고, 사람이 그 입력 없이 workflow_dispatch를 수동 실행하면 가드 없이
  // 항상 진행한다.
  if (market === "US" && process.env.GITHUB_EVENT_SCHEDULE) {
    const schedule = determineUsBatchSchedule(startedAt, process.env.GITHUB_EVENT_SCHEDULE);
    console.log(schedule.reason);
    if (!schedule.shouldRun) {
      return;
    }
  }

  if (await alreadyRanToday(market)) {
    console.log(`오늘 ${market} 배치가 이미 실행된 기록이 있어 건너뜁니다(중복 매매 방지).`);
    return;
  }

  const allPortfolios = await loadPortfolios();
  const portfolios = allPortfolios.filter((p) => p.market === market);

  console.log("=== 1단계: 전략 반영 ===");
  const strategyByStyle = new Map<PaperStyle, ActiveStrategyRow>();
  for (const style of STYLES) {
    const previous = await loadActiveStrategy(style);
    const strategy = await determineStrategyForToday(style, previous);
    if (strategy) strategyByStyle.set(style, strategy);
  }

  console.log("=== 2단계: 매매 판단 ===");
  const candidates = await loadCandidates(market);
  console.log(`  매수 후보(활성 스크리닝 결과): ${candidates.length}건`);
  const allPositions = await loadPositions(market);
  const underlyingByScreeningId = await loadUnderlyingStatuses(allPositions, candidates);

  let totalBuy = 0;
  let totalSell = 0;
  let errorCount = 0;
  const now = new Date();

  for (const portfolio of portfolios) {
    const strategyRow = strategyByStyle.get(portfolio.style);
    if (!strategyRow) continue; // determineStrategyForToday가 이미 사유를 로그로 남겼다

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

  await recordRun(market, startedAt, totalBuy, totalSell, errorCount);

  const elapsedSec = ((Date.now() - startedAt.getTime()) / 1000).toFixed(1);
  console.log(
    `AI 모의투자 배치 종료(${market}): ${elapsedSec}초 소요 (매수 ${totalBuy}건, 매도 ${totalSell}건, 오류 ${errorCount}건)`
  );
}

main().catch((error) => {
  console.error("AI 모의투자 배치 실행 중 오류가 발생했습니다:", error);
  process.exit(1);
});
