// 임시 읽기 전용 점검(전략 정리 적용 확인). 쓰기 없음.
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { STRATEGY_BACKTEST_DISPLAY_STAGE, STRATEGY_BACKTEST_ENDED_STRATEGIES } from "@/lib/strategyBacktestSummaryConfig";
import { selectLatestSummaries } from "@/lib/strategyBacktestSelection";
import { isOperatingRuleType } from "@/lib/strategyVersions";
import { PAPER_STYLE_ORDER, PAPER_STYLE_MARKETS } from "@/lib/paperStyles";
import { formatPercent } from "@/lib/formatNumber";

type R = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
async function all(table: string, cols: string): Promise<R[]> {
  const out: R[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabaseAdmin.from(table).select(cols).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as unknown as R[]));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}
const tally = (rows: R[], key: (r: R) => string) => { const m: Record<string, number> = {}; for (const r of rows) { const k = key(r); m[k] = (m[k] ?? 0) + 1; } return JSON.stringify(m); };

async function main() {
  console.log("== A. 종료된 전략 표시값 vs DB (stage=" + STRATEGY_BACKTEST_DISPLAY_STAGE + ") ==");
  const sums = await all("strategy_backtest_summary", "*");
  sums.sort((a, b) => String(b.computed_at).localeCompare(String(a.computed_at)));
  const shown = selectLatestSummaries(sums as (R & { rule_type: string; market: string; data_widen_stage: string | null })[], STRATEGY_BACKTEST_DISPLAY_STAGE);
  const fp = (v: number | null) => (v === null || v === undefined ? "-" : formatPercent(v));
  for (const e of STRATEGY_BACKTEST_ENDED_STRATEGIES) {
    const r = shown.find((x) => x.rule_type === e.ruleType && x.market === "KR");
    if (!r) { console.log(e.ruleType, "행 없음"); continue; }
    const payoff = r.payoff_ratio === null ? "-" : `${Number(r.payoff_ratio).toFixed(2)}:1`;
    console.log(JSON.stringify({ 전략: e.ruleType, 계산시각: r.computed_at, 기간: `${r.period_start_date}~${r.period_end_date}`,
      DB: { win: r.win_rate, avg: r.avg_return_pct, median: r.median_return_pct, payoff: r.payoff_ratio, mdd: r.mdd_pct, cagr: r.cagr_pct, trades: r.total_trades },
      표시: { 승률: r.win_rate === null ? "-" : formatPercent(r.win_rate * 100, { sign: false }), 평균: fp(r.avg_return_pct), 중앙값: fp(r.median_return_pct), 손익비: payoff, MDD: `-${Number(r.mdd_pct).toFixed(2)}%`, CAGR: fp(r.cagr_pct), 거래수: `${r.total_trades}건` } }));
  }
  console.log("stage별 행 수(strategy_backtest_summary):", tally(sums, (r) => `${r.rule_type}|${r.data_widen_stage ?? "null"}`));

  console.log("== B. 테이블별 행 수(보존 확인) ==");
  const strategies = await all("strategies", "id, rule_type, market");
  console.log("strategies:", tally(strategies, (r) => `${r.rule_type}/${r.market}`));
  console.log("screening 대상 전략(운영):", tally(strategies.filter((s) => isOperatingRuleType(s.rule_type)), (r) => `${r.rule_type}/${r.market}`), "| 건너뜀:", tally(strategies.filter((s) => !isOperatingRuleType(s.rule_type)), (r) => r.rule_type));
  const typeById = new Map(strategies.map((s) => [s.id as string, s.rule_type as string]));
  const sr = await all("screening_results", "id, strategy_id, status, matched_at");
  console.log("screening_results(전략·상태):", tally(sr, (r) => `${typeById.get(r.strategy_id) ?? "?"}|${r.status}`));
  const lastMatch: Record<string, string> = {};
  for (const r of sr) { const t = typeById.get(r.strategy_id) ?? "?"; if (!lastMatch[t] || r.matched_at > lastMatch[t]) lastMatch[t] = r.matched_at; }
  console.log("전략별 마지막 신호 matched_at:", JSON.stringify(lastMatch));
  const ports = await all("paper_portfolios", "id, style, market");
  console.log("paper_portfolios:", tally(ports, (r) => `${r.style}:${r.market}`));
  const ps = await all("paper_strategies", "id, style, is_active");
  console.log("paper_strategies(스타일|활성):", tally(ps, (r) => `${r.style}|${r.is_active}`));
  const styleByPort = new Map(ports.map((p) => [p.id as string, p.style as string]));
  const pos = await all("paper_positions", "id, portfolio_id, screening_result_id");
  const srType = new Map(sr.map((r) => [r.id as string, typeById.get(r.strategy_id) ?? "?"]));
  console.log("paper_positions(스타일|출처 전략):", tally(pos, (r) => `${styleByPort.get(r.portfolio_id) ?? "?"}|${r.screening_result_id ? (srType.get(r.screening_result_id) ?? "?") : "신호없음"}`));
  const trades = await all("paper_trades", "id, portfolio_id");
  console.log("paper_trades(스타일):", tally(trades, (r) => styleByPort.get(r.portfolio_id) ?? "?"));
  const snaps = await all("paper_snapshots", "id, portfolio_id").catch(() => [] as R[]);
  console.log("paper_snapshots(스타일):", tally(snaps, (r) => styleByPort.get(r.portfolio_id) ?? "?"));
  for (const t of ["custom_backtest_runs", "benchmark_summary", "stock_price_adjustment_events"]) {
    const { count, error } = await supabaseAdmin.from(t).select("*", { count: "exact", head: true });
    console.log(t, error ? `조회 실패: ${error.message}` : `${count}행`);
  }

  console.log("== C. paper-trade 배치 계좌 구성 검사(loadPortfolios 로직 재현) ==");
  const expected = new Set<string>(); for (const s of PAPER_STYLE_ORDER) for (const m of PAPER_STYLE_MARKETS[s]) expected.add(`${s}:${m}`);
  const operating = ports.filter((p) => (PAPER_STYLE_ORDER as readonly string[]).includes(p.style));
  const actual = new Set(operating.map((p) => `${p.style}:${p.market}`));
  console.log("기대", [...expected].sort().join(","), "| 실제(운영 스타일)", [...actual].sort().join(","), "| 일치", expected.size === actual.size && [...expected].every((k) => actual.has(k)));
  const active = ps.filter((p) => p.is_active);
  console.log("활성 전략 style:", active.map((p) => p.style).join(","));
  const { data: act } = await supabaseAdmin.from("paper_strategies").select("style, entry_conditions").eq("is_active", true);
  for (const a of act ?? []) console.log(" ", a.style, "source_rule_types =", JSON.stringify((a.entry_conditions as R)?.source_rule_types));
  const { data: runs } = await supabaseAdmin.from("paper_runs").select("market, finished_at").order("finished_at", { ascending: false }).limit(3);
  console.log("최근 paper_runs:", JSON.stringify(runs));
  const { data: sruns } = await supabaseAdmin.from("screening_runs").select("*").order("finished_at", { ascending: false }).limit(2);
  console.log("최근 screening_runs:", JSON.stringify(sruns));
}
main().catch((e) => { console.error(e); process.exit(1); });
