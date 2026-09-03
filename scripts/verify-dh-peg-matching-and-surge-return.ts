/**
 * (임시) 두 과거 버그 수정이 실제로 배포 후 정상 동작하는지 실데이터로 검증한다.
 * DB에는 아무것도 쓰지 않는 읽기 전용 검증 — 확인 끝나면 정리 PR에서 스크립트/워크플로와
 * 함께 삭제한다.
 *
 * 1) DH전략/PEG전략 등 펀더멘털 스캔 0건 버그(커밋 a9c6916, #200):
 *    screening_results/screening_runs를 최근 실행 기준으로 그대로 조회해 dh_value_dividend/
 *    peg_lynch 매칭 건수가 정상화됐는지 확인한다.
 * 2) AI 모의투자 급등주 계좌 수익률 이상 버그(커밋 a051535, #188):
 *    surge_stock(+비교 대상 conservative/aggressive) 계좌의 paper_positions/
 *    paper_daily_snapshots를 조회해 cash + Σ(quantity*avg_price) 검산이 저장된
 *    equity/cumulative_return_pct와 상식적으로 맞는지 확인한다.
 *
 * 필요 환경변수: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   tsx --conditions=react-server scripts/verify-dh-peg-matching-and-surge-return.ts
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";

function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined) return "null";
  return n.toLocaleString("ko-KR", { maximumFractionDigits: 4 });
}

function kstDateOf(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

async function checkScreeningRuns(): Promise<void> {
  console.log("\n===== 1) screening_runs 최근 실행 이력 =====");
  const { data, error } = await supabaseAdmin
    .from("screening_runs")
    .select("id, started_at, finished_at, scanned_count, matched_count, error_count")
    .order("finished_at", { ascending: false })
    .limit(20);
  if (error) throw new Error(`screening_runs 조회 실패: ${error.message}`);
  for (const r of data ?? []) {
    console.log(
      `  [${kstDateOf(r.finished_at)}] started_at=${r.started_at} finished_at=${r.finished_at} ` +
        `scanned=${r.scanned_count} matched=${r.matched_count} error=${r.error_count}`
    );
  }
}

async function checkDhPegMatching(): Promise<void> {
  console.log("\n===== 2) dh_value_dividend / peg_lynch 전략 screening_results =====");
  const { data: strategies, error: strategyError } = await supabaseAdmin
    .from("strategies")
    .select("id, name, rule_type, market")
    .in("rule_type", ["dh_value_dividend", "peg_lynch"]);
  if (strategyError) throw new Error(`strategies 조회 실패: ${strategyError.message}`);
  console.log(`  strategies: ${strategies?.length ?? 0}건`);
  for (const s of strategies ?? []) {
    console.log(`    [strategy] id=${s.id} name=${s.name} rule_type=${s.rule_type} market=${s.market}`);
  }

  const strategyIds = (strategies ?? []).map((s) => s.id as string);
  if (strategyIds.length === 0) {
    console.log("  dh_value_dividend/peg_lynch 전략이 하나도 없음 — 시드 마이그레이션 확인 필요");
    return;
  }

  const { data: results, error: resultsError } = await supabaseAdmin
    .from("screening_results")
    .select("id, strategy_id, stock_code, stock_name, signal_price, entry_price, current_price, return_pct, status, matched_at")
    .in("strategy_id", strategyIds)
    .order("matched_at", { ascending: false })
    .limit(200);
  if (resultsError) throw new Error(`screening_results 조회 실패: ${resultsError.message}`);

  const strategyById = new Map((strategies ?? []).map((s) => [s.id as string, s]));
  const countsByDateAndRuleType = new Map<string, number>();
  for (const r of results ?? []) {
    const strategy = strategyById.get(r.strategy_id as string);
    const key = `${kstDateOf(r.matched_at)} / ${strategy?.rule_type ?? "?"}`;
    countsByDateAndRuleType.set(key, (countsByDateAndRuleType.get(key) ?? 0) + 1);
  }

  console.log(`  screening_results(dh_value_dividend/peg_lynch, 최근 200건 중): 총 ${results?.length ?? 0}건`);
  console.log("  날짜별/전략별 건수:");
  for (const [key, count] of [...countsByDateAndRuleType.entries()].sort()) {
    console.log(`    ${key}: ${count}건`);
  }

  console.log("  최근 매칭 상세(최대 20건):");
  for (const r of (results ?? []).slice(0, 20)) {
    const strategy = strategyById.get(r.strategy_id as string);
    console.log(
      `    [${kstDateOf(r.matched_at)}] ${strategy?.rule_type} ${r.stock_name}(${r.stock_code}) ` +
        `signal_price=${fmt(r.signal_price)} entry_price=${fmt(r.entry_price)} current_price=${fmt(r.current_price)} ` +
        `return_pct=${fmt(r.return_pct)} status=${r.status} matched_at=${r.matched_at}`
    );
  }
}

interface PortfolioRow {
  id: string;
  style: string;
  market: string;
  initial_capital: number;
  cash: number;
}

async function checkPaperTradingReturns(): Promise<void> {
  console.log("\n===== 3) AI 모의투자 계좌별 수익률 검산 =====");
  const { data: portfolios, error: portfolioError } = await supabaseAdmin
    .from("paper_portfolios")
    .select("id, style, market, initial_capital, cash")
    .order("style", { ascending: true });
  if (portfolioError) throw new Error(`paper_portfolios 조회 실패: ${portfolioError.message}`);

  for (const portfolio of (portfolios ?? []) as PortfolioRow[]) {
    console.log(`\n  ----- [${portfolio.style} / ${portfolio.market}] portfolio_id=${portfolio.id} -----`);
    console.log(`    cash=${fmt(portfolio.cash)} initial_capital=${fmt(portfolio.initial_capital)}`);

    const { data: positions, error: positionsError } = await supabaseAdmin
      .from("paper_positions")
      .select("id, stock_code, stock_name, quantity, avg_price, screening_result_id, opened_at")
      .eq("portfolio_id", portfolio.id);
    if (positionsError) throw new Error(`paper_positions 조회 실패: ${positionsError.message}`);

    let holdingsValueAtAvgPrice = 0;
    for (const p of positions ?? []) {
      holdingsValueAtAvgPrice += p.quantity * p.avg_price;
      console.log(
        `      [pos] ${p.stock_name}(${p.stock_code}) qty=${p.quantity} avg_price=${fmt(p.avg_price)} ` +
          `opened_at=${p.opened_at} screening_result_id=${p.screening_result_id ?? "null"}`
      );
    }
    const equityAtAvgPrice = portfolio.cash + holdingsValueAtAvgPrice;
    console.log(
      `    검산(avg_price 기준): cash(${fmt(portfolio.cash)}) + holdings(${fmt(holdingsValueAtAvgPrice)}) = ${fmt(equityAtAvgPrice)} ` +
        `vs initial_capital=${fmt(portfolio.initial_capital)} (차이 ${fmt(equityAtAvgPrice - portfolio.initial_capital)})`
    );

    const { data: snapshots, error: snapshotsError } = await supabaseAdmin
      .from("paper_daily_snapshots")
      .select("snapshot_date, cash, holdings_value, equity, daily_return_pct, cumulative_return_pct")
      .eq("portfolio_id", portfolio.id)
      .order("snapshot_date", { ascending: true });
    if (snapshotsError) throw new Error(`paper_daily_snapshots 조회 실패: ${snapshotsError.message}`);

    console.log(`    paper_daily_snapshots: ${snapshots?.length ?? 0}건`);
    for (const s of snapshots ?? []) {
      const recomputedEquity = s.cash + s.holdings_value;
      console.log(
        `      [snap] ${s.snapshot_date} cash=${fmt(s.cash)} holdings_value=${fmt(s.holdings_value)} equity=${fmt(s.equity)} ` +
          `(cash+holdings=${fmt(recomputedEquity)}, 일치? ${Math.abs(recomputedEquity - s.equity) < 1}) ` +
          `daily_return_pct=${fmt(s.daily_return_pct)} cumulative_return_pct=${fmt(s.cumulative_return_pct)}`
      );
    }
  }
}

async function main(): Promise<void> {
  await checkScreeningRuns();
  await checkDhPegMatching();
  await checkPaperTradingReturns();
  console.log("\n===== 검증 완료 =====");
}

main().catch((err) => {
  console.error("검증 실패:", err);
  process.exitCode = 1;
});
