/**
 * (임시) 급등주(surge_stock) AI 모의투자 계좌의 화면 표시 평가금액(1,016,015원/+1.60%)이
 * 사용자의 수기 검산(990,320원/-0.97%)과 25,695원 차이 나는 문제, 보유종목 현재가가
 * 전부 평단가와 동일(0.00%)하게 보이는 문제, 일간·누적 수익률이 동일하게 나오는 문제를
 * 실데이터로 조사한다. DB에는 아무것도 쓰지 않는 읽기 전용 진단 — 확인 끝나면 정리
 * PR에서 스크립트/워크플로와 함께 삭제한다.
 *
 * 확인 순서:
 * 1) surge_stock(KR) 계좌: paper_portfolios(cash/initial_capital), paper_positions
 *    전체(5건이어야 함 — 한국비엔씨는 매도됐으니 없어야 함), 각 포지션의
 *    screening_results.current_price(서버 admin 권한으로 실제 값 조회)로 평가금액을
 *    직접 재계산해 paper_daily_snapshots에 저장된 값과 비교
 * 2) paper_trades 전체(오늘+어제) 조회 — 한국비엔씨 매도의 realized_pnl이 정확히
 *    한 번만 기록됐는지, 매도 후 포지션이 실제로 삭제됐는지 확인
 * 3) 보유종목 현재가 표시 버그 조사: 컴포넌트(components/PaperTrading.tsx)는 클라이언트
 *    RLS 권한(anon/authenticated)으로 screening_results를 직접 조회하는데, 이 표의
 *    select 정책(screening_results_select_own)은 "그 screening_results.strategy_id가
 *    가리키는 strategies.user_id가 현재 로그인한 사용자와 같아야" 통과한다.
 *    reversal_breakout 전략은 "계정마다 한 행씩" 시딩되므로(여러 계정이 있으면) 실제
 *    포지션이 참조하는 screening_result_id의 strategy가 로그인한 사용자 소유가 아닐
 *    수 있다 — 이러면 클라이언트 쿼리가 그 행을 못 읽어 currentPrice=null이 되고
 *    화면은 `h.currentPrice ?? h.avg_price`로 평단가를 그대로 보여준다(0.00%처럼
 *    보임). auth.users/profiles/strategies(rule_type=reversal_breakout)를 조회해
 *    이 가설을 확인한다.
 * 4) paper_daily_snapshots(surge_stock) 전체 이력 — daily_return_pct/
 *    cumulative_return_pct가 baseline(전일 equity)과 initial_capital 중 어느 쪽 기준인지
 *    직접 재계산해 비교. 어제(전일) equity가 initial_capital과 우연히 같으면 둘이
 *    같아지는 게 정상이라는 뜻이므로 그 경우도 표시한다.
 * 5) 비교 대상으로 conservative/aggressive도 1)~3) 동일하게 조회
 *
 * 필요 환경변수: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   tsx --conditions=react-server scripts/diagnose-surge-stock-equity-mismatch.ts
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";

function todayKstDate(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined) return "null";
  return n.toLocaleString("ko-KR", { maximumFractionDigits: 6 });
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
  strategy_id: string;
  current_price: number;
  status: string;
}

interface StrategyRow {
  id: string;
  user_id: string;
  rule_type: string;
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
  realized_pnl: number | null;
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

async function loadPortfolio(style: string, market: string): Promise<PortfolioRow> {
  const { data, error } = await supabaseAdmin
    .from("paper_portfolios")
    .select("id, style, market, initial_capital, cash")
    .eq("style", style)
    .eq("market", market)
    .single();
  if (error || !data) throw new Error(`${style}(${market}) 계좌 조회 실패: ${error?.message ?? "not found"}`);
  return data as PortfolioRow;
}

async function loadPositions(portfolioId: string): Promise<PositionRow[]> {
  const { data, error } = await supabaseAdmin
    .from("paper_positions")
    .select("id, portfolio_id, stock_code, stock_name, quantity, avg_price, opened_at, screening_result_id")
    .eq("portfolio_id", portfolioId);
  if (error) throw new Error(`포지션 조회 실패: ${error.message}`);
  return (data ?? []) as PositionRow[];
}

async function loadScreeningResults(ids: string[]): Promise<Map<string, ScreeningResultRow>> {
  if (ids.length === 0) return new Map();
  const { data, error } = await supabaseAdmin
    .from("screening_results")
    .select("id, stock_code, strategy_id, current_price, status")
    .in("id", ids);
  if (error) throw new Error(`screening_results 조회 실패: ${error.message}`);
  return new Map((data ?? []).map((r) => [r.id as string, r as ScreeningResultRow]));
}

async function loadStrategies(ids: string[]): Promise<Map<string, StrategyRow>> {
  if (ids.length === 0) return new Map();
  const { data, error } = await supabaseAdmin.from("strategies").select("id, user_id, rule_type, market").in("id", ids);
  if (error) throw new Error(`strategies 조회 실패: ${error.message}`);
  return new Map((data ?? []).map((r) => [r.id as string, r as StrategyRow]));
}

async function investigateStyle(style: string, market: string): Promise<void> {
  console.log(`\n===== [${style}/${market}] =====`);
  const portfolio = await loadPortfolio(style, market);
  console.log(`paper_portfolios: cash=${fmt(portfolio.cash)} initial_capital=${fmt(portfolio.initial_capital)}`);

  const positions = await loadPositions(portfolio.id);
  console.log(`paper_positions: ${positions.length}건`);

  const screeningIds = positions.map((p) => p.screening_result_id).filter((id): id is string => id !== null);
  const screeningById = await loadScreeningResults(screeningIds);
  const strategyIds = Array.from(new Set(Array.from(screeningById.values()).map((r) => r.strategy_id)));
  const strategyById = await loadStrategies(strategyIds);

  let holdingsValueReal = 0;
  let holdingsValueAvg = 0;
  for (const p of positions) {
    const sr = p.screening_result_id ? screeningById.get(p.screening_result_id) : undefined;
    const strategy = sr ? strategyById.get(sr.strategy_id) : undefined;
    const realPrice = sr?.current_price ?? p.avg_price;
    holdingsValueReal += p.quantity * realPrice;
    holdingsValueAvg += p.quantity * p.avg_price;
    console.log(
      `  [pos] ${p.stock_name}(${p.stock_code}) qty=${p.quantity} avg_price=${fmt(p.avg_price)} ` +
        `real_current_price(admin)=${fmt(sr?.current_price)} status=${sr?.status ?? "N/A"} ` +
        `avg==real? ${p.avg_price === sr?.current_price} strategy_owner_user_id=${strategy?.user_id ?? "N/A"}`
    );
  }
  console.log(
    `→ 실제 현재가 기준 holdings_value=${fmt(holdingsValueReal)} / 평단가 기준(폴백 상황)=${fmt(holdingsValueAvg)} ` +
      `(차이=${fmt(holdingsValueReal - holdingsValueAvg)})`
  );
  const equityReal = portfolio.cash + holdingsValueReal;
  console.log(`→ cash + 실제현재가 holdings = ${fmt(equityReal)}`);

  const { data: trades, error: tradesError } = await supabaseAdmin
    .from("paper_trades")
    .select("id, portfolio_id, stock_code, stock_name, side, quantity, price, amount, realized_pnl, screening_result_id, traded_at")
    .eq("portfolio_id", portfolio.id)
    .order("traded_at", { ascending: true });
  if (tradesError) throw new Error(`거래 조회 실패: ${tradesError.message}`);
  console.log(`paper_trades 전체: ${(trades ?? []).length}건`);
  let cashCheck = portfolio.initial_capital;
  for (const t of (trades ?? []) as TradeRow[]) {
    cashCheck += t.side === "buy" ? -t.amount : t.amount;
    console.log(
      `  [trade] ${t.traded_at} ${t.side} ${t.stock_name}(${t.stock_code}) qty=${t.quantity} price=${fmt(t.price)} ` +
        `amount=${fmt(t.amount)} realized_pnl=${fmt(t.realized_pnl)} → 누적현금검산=${fmt(cashCheck)}`
    );
  }
  console.log(`→ 거래 로그로 재계산한 최종 현금=${fmt(cashCheck)} vs paper_portfolios.cash=${fmt(portfolio.cash)} (일치? ${cashCheck === portfolio.cash})`);

  const { data: snapshots, error: snapError } = await supabaseAdmin
    .from("paper_daily_snapshots")
    .select("portfolio_id, snapshot_date, cash, holdings_value, equity, daily_return_pct, cumulative_return_pct")
    .eq("portfolio_id", portfolio.id)
    .order("snapshot_date", { ascending: true });
  if (snapError) throw new Error(`스냅샷 조회 실패: ${snapError.message}`);
  console.log(`paper_daily_snapshots 전체: ${(snapshots ?? []).length}건`);
  let prevEquity: number | null = null;
  for (const s of (snapshots ?? []) as SnapshotRow[]) {
    const recomputedDaily = prevEquity !== null && prevEquity > 0 ? ((s.equity - prevEquity) / prevEquity) * 100 : null;
    const recomputedCum =
      portfolio.initial_capital > 0 ? ((s.equity - portfolio.initial_capital) / portfolio.initial_capital) * 100 : null;
    console.log(
      `  [snap] ${s.snapshot_date} cash=${fmt(s.cash)} holdings_value=${fmt(s.holdings_value)} equity=${fmt(s.equity)} ` +
        `daily_return_pct(저장값)=${fmt(s.daily_return_pct)}% (재계산=${fmt(recomputedDaily)}%, baseline=전일equity=${fmt(prevEquity)}) ` +
        `cumulative_return_pct(저장값)=${fmt(s.cumulative_return_pct)}% (재계산=${fmt(recomputedCum)}%)`
    );
    prevEquity = s.equity;
  }

  console.log(`--- 스크리닝 원본 매칭 전략 소유자 정보 ---`);
  for (const id of strategyIds) {
    const s = strategyById.get(id);
    console.log(`  strategy_id=${id} rule_type=${s?.rule_type} user_id=${s?.user_id}`);
  }
}

async function main(): Promise<void> {
  console.log(`=== 급등주 평가금액 불일치(+25,695원) + 현재가=평단가 표시 + 일간=누적 조사 (오늘 KST: ${todayKstDate()}) ===`);

  const { data: users, error: usersError } = await supabaseAdmin.auth.admin.listUsers();
  if (usersError) {
    console.error(`auth.users 조회 실패: ${usersError.message}`);
  } else {
    console.log(`\n--- auth.users 전체 ${users.users.length}명 ---`);
    for (const u of users.users) {
      console.log(`  id=${u.id} email=${u.email}`);
    }
  }

  const { data: profiles, error: profilesError } = await supabaseAdmin
    .from("profiles")
    .select("user_id, email, status, is_admin");
  if (profilesError) throw new Error(`profiles 조회 실패: ${profilesError.message}`);
  console.log(`\n--- profiles 전체 ${(profiles ?? []).length}명 ---`);
  for (const p of profiles ?? []) {
    console.log(`  user_id=${p.user_id} email=${p.email} status=${p.status} is_admin=${p.is_admin}`);
  }

  const { data: reversalStrategies, error: reversalError } = await supabaseAdmin
    .from("strategies")
    .select("id, user_id, rule_type, market")
    .eq("rule_type", "reversal_breakout")
    .eq("market", "KR");
  if (reversalError) throw new Error(`reversal_breakout strategies 조회 실패: ${reversalError.message}`);
  console.log(`\n--- rule_type=reversal_breakout strategies 전체 ${(reversalStrategies ?? []).length}건 ---`);
  for (const s of reversalStrategies ?? []) {
    console.log(`  id=${s.id} user_id=${s.user_id}`);
  }

  await investigateStyle("surge_stock", "KR");
  await investigateStyle("conservative", "KR");
  await investigateStyle("aggressive", "KR");

  console.log("\n=== 조사 종료 ===");
}

main().catch((error) => {
  console.error("진단 스크립트 실행 중 오류:", error);
  process.exit(1);
});
