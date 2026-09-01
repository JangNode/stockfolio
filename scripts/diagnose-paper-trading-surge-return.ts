/**
 * (임시) AI 모의투자 "급등주"(surge_stock) 계좌의 당일 매수 종목이 벌써 큰 폭의 평가
 * 수익률을 보이는 이상 현상을 실데이터로 조사한다. DB에는 아무것도 쓰지 않는 읽기
 * 전용 진단 — 확인 끝나면 정리 PR에서 스크립트/워크플로와 함께 삭제한다.
 *
 * 확인 순서(사용자 요청 그대로):
 * 1) surge_stock 계좌의 paper_positions 전체 행
 * 2) 각 포지션의 screening_result_id로 screening_results 조인(current_price/entry_price/
 *    return_pct/matched_at/status) — avg_price와 나란히 비교
 * 3) 오늘자 paper_trades(side=buy, surge_stock)의 실제 체결가
 * 4) paper_portfolios(surge_stock)의 cash/initial_capital
 * 5) paper_daily_snapshots(surge_stock) 최근 며칠치
 * 6) 위 값으로 직접 검산(cash + Σquantity*price = equity, cumulativeReturnPct)
 * 7) 비교 대상으로 conservative/aggressive 계좌도 1~3과 동일하게 출력
 *
 * 필요 환경변수: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   tsx --conditions=react-server scripts/diagnose-paper-trading-surge-return.ts
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";

function todayKstDate(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined) return "null";
  return n.toLocaleString("ko-KR", { maximumFractionDigits: 4 });
}

interface PortfolioRow {
  id: string;
  style: string;
  market: string;
  initial_capital: number;
  cash: number;
}

interface PositionRow {
  id: string;
  portfolio_id: string;
  stock_code: string;
  stock_name: string;
  quantity: number;
  avg_price: number;
  opened_at: string;
  screening_result_id: string | null;
}

interface ScreeningResultRow {
  id: string;
  stock_code: string;
  stock_name: string;
  strategy_id: string;
  current_price: number;
  entry_price: number;
  signal_price: number;
  return_pct: number;
  status: string;
  matched_at: string;
  market: string;
}

interface TradeRow {
  id: string;
  portfolio_id: string;
  stock_code: string;
  stock_name: string;
  side: string;
  quantity: number;
  price: number;
  amount: number;
  screening_result_id: string | null;
  traded_at: string;
}

interface SnapshotRow {
  portfolio_id: string;
  snapshot_date: string;
  cash: number;
  holdings_value: number;
  equity: number;
  daily_return_pct: number;
  cumulative_return_pct: number;
}

async function loadPortfolios(): Promise<PortfolioRow[]> {
  const { data, error } = await supabaseAdmin
    .from("paper_portfolios")
    .select("id, style, market, initial_capital, cash");
  if (error) throw new Error(`paper_portfolios 조회 실패: ${error.message}`);
  return (data ?? []) as PortfolioRow[];
}

async function loadPositionsForPortfolio(portfolioId: string): Promise<PositionRow[]> {
  const { data, error } = await supabaseAdmin
    .from("paper_positions")
    .select("id, portfolio_id, stock_code, stock_name, quantity, avg_price, opened_at, screening_result_id")
    .eq("portfolio_id", portfolioId);
  if (error) throw new Error(`paper_positions 조회 실패: ${error.message}`);
  return (data ?? []) as PositionRow[];
}

async function loadScreeningResults(ids: string[]): Promise<Map<string, ScreeningResultRow>> {
  if (ids.length === 0) return new Map();
  const { data, error } = await supabaseAdmin
    .from("screening_results")
    .select("id, stock_code, stock_name, strategy_id, current_price, entry_price, signal_price, return_pct, status, matched_at, market")
    .in("id", ids);
  if (error) throw new Error(`screening_results 조회 실패: ${error.message}`);
  return new Map((data ?? []).map((r) => [r.id as string, r as ScreeningResultRow]));
}

async function loadTodayBuyTrades(portfolioId: string): Promise<TradeRow[]> {
  const today = todayKstDate();
  const { data, error } = await supabaseAdmin
    .from("paper_trades")
    .select("id, portfolio_id, stock_code, stock_name, side, quantity, price, amount, screening_result_id, traded_at")
    .eq("portfolio_id", portfolioId)
    .eq("side", "buy")
    .order("traded_at", { ascending: false });
  if (error) throw new Error(`paper_trades 조회 실패: ${error.message}`);
  return ((data ?? []) as TradeRow[]).filter(
    (t) => new Date(t.traded_at).toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" }) === today
  );
}

async function loadSnapshots(portfolioId: string): Promise<SnapshotRow[]> {
  const { data, error } = await supabaseAdmin
    .from("paper_daily_snapshots")
    .select("portfolio_id, snapshot_date, cash, holdings_value, equity, daily_return_pct, cumulative_return_pct")
    .eq("portfolio_id", portfolioId)
    .order("snapshot_date", { ascending: true });
  if (error) throw new Error(`paper_daily_snapshots 조회 실패: ${error.message}`);
  return (data ?? []) as SnapshotRow[];
}

async function investigateStyle(portfolio: PortfolioRow, fullDetail: boolean): Promise<void> {
  console.log(`\n----- [${portfolio.style} / ${portfolio.market}] portfolio_id=${portfolio.id} -----`);
  console.log(`  paper_portfolios: cash=${fmt(portfolio.cash)}, initial_capital=${fmt(portfolio.initial_capital)}`);

  const positions = await loadPositionsForPortfolio(portfolio.id);
  console.log(`  paper_positions: ${positions.length}건`);

  const screeningIds = positions
    .map((p) => p.screening_result_id)
    .filter((id): id is string => id !== null);
  const screeningById = await loadScreeningResults(screeningIds);

  let holdingsValueUsingCurrentPrice = 0;
  let holdingsValueUsingAvgPrice = 0;

  for (const p of positions) {
    const sr = p.screening_result_id ? screeningById.get(p.screening_result_id) : undefined;
    const currentPrice = sr?.current_price ?? null;
    const pnlPct =
      currentPrice !== null ? (((currentPrice - p.avg_price) / p.avg_price) * 100).toFixed(2) : "N/A";
    console.log(
      `    [pos] ${p.stock_name}(${p.stock_code}) qty=${p.quantity} avg_price=${fmt(p.avg_price)} ` +
        `opened_at=${p.opened_at} screening_result_id=${p.screening_result_id ?? "null"}`
    );
    if (sr) {
      console.log(
        `      [screening_results] id=${sr.id} strategy_id=${sr.strategy_id} stock=${sr.stock_name}(${sr.stock_code}) ` +
          `current_price=${fmt(sr.current_price)} entry_price=${fmt(sr.entry_price)} signal_price=${fmt(sr.signal_price)} ` +
          `return_pct=${fmt(sr.return_pct)} status=${sr.status} matched_at=${sr.matched_at} market=${sr.market}`
      );
      console.log(
        `      => avg_price=${fmt(p.avg_price)} vs screening_results.current_price=${fmt(sr.current_price)} vs entry_price=${fmt(sr.entry_price)} ` +
          `| avg_price==current_price? ${p.avg_price === sr.current_price} | avg_price==entry_price? ${p.avg_price === sr.entry_price} ` +
          `| pos.stock_code==sr.stock_code? ${p.stock_code === sr.stock_code} | 즉시평가손익(현재가 기준)=${pnlPct}%`
      );
    } else if (p.screening_result_id) {
      console.log(`      [screening_results] id=${p.screening_result_id}에 해당하는 행을 찾지 못함(고아 참조 가능성)`);
    } else {
      console.log(`      [screening_results] screening_result_id가 null`);
    }

    if (currentPrice !== null) holdingsValueUsingCurrentPrice += p.quantity * currentPrice;
    holdingsValueUsingAvgPrice += p.quantity * p.avg_price;
  }

  const trades = await loadTodayBuyTrades(portfolio.id);
  console.log(`  paper_trades(오늘자, side=buy): ${trades.length}건`);
  for (const t of trades) {
    const sr = t.screening_result_id ? screeningById.get(t.screening_result_id) : undefined;
    console.log(
      `    [trade] ${t.stock_name}(${t.stock_code}) qty=${t.quantity} price=${fmt(t.price)} amount=${fmt(t.amount)} ` +
        `screening_result_id=${t.screening_result_id ?? "null"} traded_at=${t.traded_at}` +
        (sr ? ` | trade.price==screening_results.current_price(지금)? ${t.price === sr.current_price}` : "")
    );
  }

  if (fullDetail) {
    const snapshots = await loadSnapshots(portfolio.id);
    console.log(`  paper_daily_snapshots: ${snapshots.length}건`);
    for (const s of snapshots) {
      console.log(
        `    [snap] ${s.snapshot_date} cash=${fmt(s.cash)} holdings_value=${fmt(s.holdings_value)} equity=${fmt(s.equity)} ` +
          `daily_return_pct=${fmt(s.daily_return_pct)} cumulative_return_pct=${fmt(s.cumulative_return_pct)}`
      );
    }

    console.log(`  --- 검산 ---`);
    console.log(
      `  cash(현재 paper_portfolios.cash)=${fmt(portfolio.cash)}`
    );
    console.log(
      `  Σ(quantity × screening_results.current_price) = ${fmt(holdingsValueUsingCurrentPrice)} ` +
        `→ cash+holdings = ${fmt(portfolio.cash + holdingsValueUsingCurrentPrice)}`
    );
    console.log(
      `  Σ(quantity × avg_price) = ${fmt(holdingsValueUsingAvgPrice)} ` +
        `→ cash+holdings(매입가 기준) = ${fmt(portfolio.cash + holdingsValueUsingAvgPrice)}`
    );
    if (snapshots.length > 0) {
      const last = snapshots[snapshots.length - 1];
      console.log(
        `  최근 스냅샷(${last.snapshot_date}): equity=${fmt(last.equity)} vs 방금 계산한 cash+holdings(current_price 기준)=${fmt(
          portfolio.cash + holdingsValueUsingCurrentPrice
        )} (차이=${fmt(last.equity - (portfolio.cash + holdingsValueUsingCurrentPrice))})`
      );
      const recomputedCumPct =
        portfolio.initial_capital > 0
          ? ((last.equity - portfolio.initial_capital) / portfolio.initial_capital) * 100
          : 0;
      console.log(
        `  cumulative_return_pct 재계산 = (${fmt(last.equity)} - ${fmt(portfolio.initial_capital)}) / ${fmt(
          portfolio.initial_capital
        )} * 100 = ${recomputedCumPct.toFixed(4)}% (DB 저장값: ${fmt(last.cumulative_return_pct)}%)`
      );
    }
  }
}

async function main(): Promise<void> {
  console.log(`=== 조사 1: 급등주(surge_stock) AI 모의투자 수익률 이상 (오늘 KST: ${todayKstDate()}) ===`);

  const portfolios = await loadPortfolios();
  console.log(`전체 paper_portfolios: ${portfolios.length}건`);
  for (const p of portfolios) {
    console.log(`  - id=${p.id} style=${p.style} market=${p.market} cash=${fmt(p.cash)} initial_capital=${fmt(p.initial_capital)}`);
  }

  const surgeStockKr = portfolios.find((p) => p.style === "surge_stock" && p.market === "KR");
  if (!surgeStockKr) {
    console.error("surge_stock(KR) 계좌를 찾지 못했습니다.");
  } else {
    await investigateStyle(surgeStockKr, true);
  }

  console.log(`\n=== 비교 대상: conservative / aggressive (KR) ===`);
  for (const style of ["conservative", "aggressive"]) {
    const p = portfolios.find((row) => row.style === style && row.market === "KR");
    if (!p) {
      console.log(`  ${style}(KR) 계좌를 찾지 못했습니다.`);
      continue;
    }
    await investigateStyle(p, false);
  }

  console.log("\n=== 조사 1 종료 ===");
}

main().catch((error) => {
  console.error("진단 스크립트 실행 중 오류:", error);
  process.exit(1);
});
