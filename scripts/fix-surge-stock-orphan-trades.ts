/**
 * (임시, 1회성) 2026-09-01 급등주(surge_stock) AI 모의투자 수익률 이상(+16.62%) 버그의
 * 잔재인 프로덕션 데이터를 정리한다. 사용자 확인 후 실행(RULES.md 6번).
 *
 * 원인(scripts/diagnose-paper-trading-surge-return.ts로 확인, lib/paperTrading.ts +
 * scripts/paper-trade.ts는 이미 수정·병합됨): 같은 배치 실행 안에서 같은 종목이 서로
 * 다른 rule_type 신호로 두 번 매수 결정에 포함됐다. paper_positions는
 * (portfolio_id, stock_code) 유니크라 두 번째 포지션 저장은 실패했지만(현금 차감 없음)
 * 그 매수의 paper_trades 기록은 이미 커밋됐고, 평가금액 계산이 그 "고아" 매수까지
 * 합산해 실제로 없는 포지션 166,200원어치가 평가금액에 얹혔다.
 *
 * 이 스크립트가 하는 일(DB 쓰기 있음 — 신중히 실행):
 * 1) surge_stock(KR) 계좌의 오늘자 buy 거래 중, 어떤 현재 포지션의 screening_result_id와도
 *    일치하지 않는 "고아" 거래를 찾아 삭제한다(그 거래는 현금도 차감 안 됐고 포지션도
 *    없으므로 삭제해도 다른 값에 영향 없음 — cash/포지션은 건드리지 않는다).
 * 2) 오늘자 paper_daily_snapshots 행의 holdings_value/equity/daily_return_pct/
 *    cumulative_return_pct를 실제 포지션(수량 × screening_results.current_price) 기준으로
 *    재계산해 덮어쓴다. cash는 원래도 정상이었으므로 그대로 둔다.
 *
 * 필요 환경변수: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   tsx --conditions=react-server scripts/fix-surge-stock-orphan-trades.ts
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";

function todayKstDate(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

function fmt(n: number): string {
  return n.toLocaleString("ko-KR", { maximumFractionDigits: 4 });
}

async function main(): Promise<void> {
  const today = todayKstDate();
  console.log(`=== 급등주(surge_stock) 고아 매수 기록 + 오늘자 스냅샷 정리 (오늘 KST: ${today}) ===`);

  const { data: portfolio, error: portfolioError } = await supabaseAdmin
    .from("paper_portfolios")
    .select("id, style, market, initial_capital, cash")
    .eq("style", "surge_stock")
    .eq("market", "KR")
    .single();
  if (portfolioError || !portfolio) {
    throw new Error(`surge_stock(KR) 계좌 조회 실패: ${portfolioError?.message ?? "not found"}`);
  }
  console.log(`portfolio_id=${portfolio.id} cash=${fmt(portfolio.cash)} initial_capital=${fmt(portfolio.initial_capital)}`);

  const { data: positions, error: positionsError } = await supabaseAdmin
    .from("paper_positions")
    .select("id, stock_code, stock_name, quantity, avg_price, screening_result_id")
    .eq("portfolio_id", portfolio.id);
  if (positionsError) throw new Error(`포지션 조회 실패: ${positionsError.message}`);
  console.log(`현재 포지션 ${positions?.length ?? 0}건:`);
  for (const p of positions ?? []) {
    console.log(`  ${p.stock_name}(${p.stock_code}) qty=${p.quantity} avg_price=${fmt(p.avg_price)} screening_result_id=${p.screening_result_id}`);
  }
  const currentScreeningResultIds = new Set((positions ?? []).map((p) => p.screening_result_id).filter((id): id is string => id !== null));

  const { data: todayBuyTrades, error: tradesError } = await supabaseAdmin
    .from("paper_trades")
    .select("id, stock_code, stock_name, quantity, price, amount, screening_result_id, traded_at")
    .eq("portfolio_id", portfolio.id)
    .eq("side", "buy")
    .order("traded_at", { ascending: false });
  if (tradesError) throw new Error(`오늘자 매수 거래 조회 실패: ${tradesError.message}`);
  const todayTrades = (todayBuyTrades ?? []).filter(
    (t) => new Date(t.traded_at).toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" }) === today
  );
  console.log(`오늘자 매수 거래 ${todayTrades.length}건:`);
  const orphanTradeIds: string[] = [];
  for (const t of todayTrades) {
    const isOrphan = t.screening_result_id === null || !currentScreeningResultIds.has(t.screening_result_id);
    console.log(
      `  [${isOrphan ? "고아(삭제 대상)" : "정상(유지)"}] ${t.stock_name}(${t.stock_code}) qty=${t.quantity} ` +
        `price=${fmt(t.price)} amount=${fmt(t.amount)} screening_result_id=${t.screening_result_id ?? "null"} id=${t.id}`
    );
    if (isOrphan) orphanTradeIds.push(t.id);
  }

  if (orphanTradeIds.length === 0) {
    console.log("고아 거래가 없습니다 — 삭제할 것이 없습니다.");
  } else {
    console.log(`\n고아 거래 ${orphanTradeIds.length}건 삭제 중...`);
    const { error: deleteError } = await supabaseAdmin.from("paper_trades").delete().in("id", orphanTradeIds);
    if (deleteError) throw new Error(`고아 거래 삭제 실패: ${deleteError.message}`);
    console.log("삭제 완료.");
  }

  // 실제 포지션 평가금액 재계산(screening_results.current_price 기준 — paper-trade.ts의
  // 정상 로직과 동일한 기준)
  const screeningIds = (positions ?? [])
    .map((p) => p.screening_result_id)
    .filter((id): id is string => id !== null);
  const { data: screeningRows, error: screeningError } = await supabaseAdmin
    .from("screening_results")
    .select("id, current_price")
    .in("id", screeningIds);
  if (screeningError) throw new Error(`screening_results 조회 실패: ${screeningError.message}`);
  const currentPriceById = new Map((screeningRows ?? []).map((r) => [r.id as string, r.current_price as number]));

  let holdingsValue = 0;
  for (const p of positions ?? []) {
    const price = p.screening_result_id ? (currentPriceById.get(p.screening_result_id) ?? p.avg_price) : p.avg_price;
    holdingsValue += p.quantity * price;
  }
  const equity = portfolio.cash + holdingsValue;
  console.log(`\n재계산된 holdings_value=${fmt(holdingsValue)}, cash=${fmt(portfolio.cash)}, equity=${fmt(equity)}`);

  const { data: prevSnapshot, error: prevError } = await supabaseAdmin
    .from("paper_daily_snapshots")
    .select("snapshot_date, equity")
    .eq("portfolio_id", portfolio.id)
    .lt("snapshot_date", today)
    .order("snapshot_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (prevError) throw new Error(`이전 스냅샷 조회 실패: ${prevError.message}`);

  const baseline = prevSnapshot?.equity ?? portfolio.initial_capital;
  const dailyReturnPct = baseline > 0 ? ((equity - baseline) / baseline) * 100 : 0;
  const cumulativeReturnPct =
    portfolio.initial_capital > 0 ? ((equity - portfolio.initial_capital) / portfolio.initial_capital) * 100 : 0;

  console.log(
    `baseline(전일 equity 또는 초기자금)=${fmt(baseline)} → daily_return_pct=${dailyReturnPct.toFixed(4)}%, ` +
      `cumulative_return_pct=${cumulativeReturnPct.toFixed(4)}%`
  );

  const { data: beforeUpdate } = await supabaseAdmin
    .from("paper_daily_snapshots")
    .select("holdings_value, equity, daily_return_pct, cumulative_return_pct")
    .eq("portfolio_id", portfolio.id)
    .eq("snapshot_date", today)
    .maybeSingle();
  console.log(
    `\n수정 전 오늘자 스냅샷: holdings_value=${fmt(beforeUpdate?.holdings_value ?? 0)} equity=${fmt(beforeUpdate?.equity ?? 0)} ` +
      `daily_return_pct=${fmt(beforeUpdate?.daily_return_pct ?? 0)}% cumulative_return_pct=${fmt(beforeUpdate?.cumulative_return_pct ?? 0)}%`
  );

  const { error: updateError } = await supabaseAdmin
    .from("paper_daily_snapshots")
    .update({
      holdings_value: holdingsValue,
      equity,
      daily_return_pct: dailyReturnPct,
      cumulative_return_pct: cumulativeReturnPct,
    })
    .eq("portfolio_id", portfolio.id)
    .eq("snapshot_date", today);
  if (updateError) throw new Error(`스냅샷 갱신 실패: ${updateError.message}`);

  console.log(
    `수정 후 오늘자 스냅샷: holdings_value=${fmt(holdingsValue)} equity=${fmt(equity)} ` +
      `daily_return_pct=${dailyReturnPct.toFixed(4)}% cumulative_return_pct=${cumulativeReturnPct.toFixed(4)}%`
  );

  console.log("\n=== 정리 완료 ===");
}

main().catch((error) => {
  console.error("정리 스크립트 실행 중 오류:", error);
  process.exit(1);
});
