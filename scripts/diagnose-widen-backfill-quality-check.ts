// 임시 읽기 전용 점검(ma_cross 50/200 전환 사전 확인). 쓰기 없음.
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadAllStockSeriesFromParquet } from "@/lib/stockDailyPricesStorage";
import { loadAppliedAdjustments } from "@/lib/stockPriceAdjustmentsStorage";
import { fetchAllRows } from "@/lib/supabasePagination";
import { runBacktest, type DailyPrice } from "@/lib/backtest";

type R = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };

async function main() {
  console.log("== A. 모의투자 ma_cross 출처 열린 포지션 ==");
  const strategies = await fetchAllRows<R>((a, b) => supabaseAdmin.from("strategies").select("id, rule_type, market, rule_params").order("id").range(a, b));
  const typeOf = new Map(strategies.map((s) => [s.id as string, s.rule_type as string]));
  console.log("ma_cross 전략 행:", JSON.stringify(strategies.filter((s) => s.rule_type === "ma_cross").map((s) => ({ market: s.market, params: s.rule_params }))));
  const ports = await fetchAllRows<R>((a, b) => supabaseAdmin.from("paper_portfolios").select("id, style, market").order("id").range(a, b));
  const styleOf = new Map(ports.map((p) => [p.id as string, `${p.style}:${p.market}`]));
  const sr = await fetchAllRows<R>((a, b) => supabaseAdmin.from("screening_results").select("id, strategy_id, status, matched_at, entry_price, stop_loss_price, take_profit_price, current_price, market").order("id").range(a, b));
  const srOf = new Map(sr.map((r) => [r.id as string, r]));
  const pos = await fetchAllRows<R>((a, b) => supabaseAdmin.from("paper_positions").select("portfolio_id, stock_code, stock_name, opened_at, screening_result_id").order("id").range(a, b));
  const ma = pos.filter((p) => p.screening_result_id && typeOf.get(srOf.get(p.screening_result_id)?.strategy_id) === "ma_cross");
  console.log("ma_cross 출처 열린 포지션:", ma.length, JSON.stringify(ma.reduce((m: Record<string, number>, p) => ((m[styleOf.get(p.portfolio_id) ?? "?"] = (m[styleOf.get(p.portfolio_id) ?? "?"] ?? 0) + 1), m), {})));
  for (const p of ma) { const s = srOf.get(p.screening_result_id)!; console.log(" ", styleOf.get(p.portfolio_id), p.stock_name, "보유시작", String(p.opened_at).slice(0, 10), "신호", s.status, "신호일", String(s.matched_at).slice(0, 10), `손절 ${s.stop_loss_price}/익절 ${s.take_profit_price}/현재 ${s.current_price}`); }
  const maRows = sr.filter((r) => typeOf.get(r.strategy_id) === "ma_cross");
  const byMk: Record<string, number> = {};
  for (const r of maRows) byMk[`${r.market}|${r.status}`] = (byMk[`${r.market}|${r.status}`] ?? 0) + 1;
  console.log("ma_cross screening_results(시장|상태):", JSON.stringify(byMk));
  const { data: act } = await supabaseAdmin.from("paper_strategies").select("style, exit_conditions, entry_conditions").eq("is_active", true).in("style", ["conservative", "aggressive"]);
  for (const a of act ?? []) console.log("활성", a.style, "exit", JSON.stringify(a.exit_conditions), "entry 범위", JSON.stringify({ min: (a.entry_conditions as R).min_signal_return_pct, max: (a.entry_conditions as R).max_signal_return_pct }));
  const dayCount: Record<string, number> = {};
  for (const r of maRows) { const d = String(r.matched_at).slice(0, 10); dayCount[d] = (dayCount[d] ?? 0) + 1; }
  const days = Object.keys(dayCount).sort().slice(-20);
  console.log("최근 20일 ma_cross 신규 신호(5/20 규칙) 합:", days.reduce((s, d) => s + dayCount[d], 0), "/", days.length, "일");

  console.log("== B. 200일선 이력 ==");
  const adj = await loadAppliedAdjustments();
  const series = await loadAllStockSeriesFromParquet(2010, new Date().getUTCFullYear(), adj);
  const last = "2026-10-06";
  const buckets = { cap500: [0, 0, 0], cap5000: [0, 0, 0] }; // [전체, ≥201행, ≥251행]
  const trades24: number[] = [], hold24: number[] = [];
  let withWindow = 0;
  for (const [, rows] of series) {
    const lr = rows[rows.length - 1];
    if (!lr || lr.tradeDate < last) continue;
    for (const [k, floor] of [["cap500", 500], ["cap5000", 5000]] as const) {
      if (lr.marketCapEok >= floor) { buckets[k][0]++; if (rows.length >= 201) buckets[k][1]++; if (rows.length >= 251) buckets[k][2]++; }
    }
    if (lr.marketCapEok >= 500 && rows.length >= 700) {
      const prices: DailyPrice[] = rows.slice(-700).map((r) => ({ date: r.tradeDate, open: r.openPrice, high: r.highPrice, low: r.lowPrice, close: r.closePrice, volume: r.volume, marketCapEok: r.marketCapEok, listedShares: r.listedShares }));
      const start = new Date(); start.setMonth(start.getMonth() - 24); const sd = start.toISOString().slice(0, 10);
      const res = runBacktest(prices, { rule_type: "ma_cross", rule_params: { short_period: 50, long_period: 200 } }, sd, undefined, undefined, { market: "KR" });
      withWindow++; trades24.push(res.trades.length);
      for (const t of res.trades) hold24.push((Date.parse(t.sellDate) - Date.parse(t.buyDate)) / 86400000);
    }
  }
  console.log("마지막 거래일(10-06) 상장 종목 중 [전체, 거래일≥201, ≥251] cap≥500억:", JSON.stringify(buckets.cap500), "cap≥5천억:", JSON.stringify(buckets.cap5000));
  console.log("화면 2년 백테스트(50/200, 700행 확보 시) 종목수", withWindow, "| 종목당 거래 수 평균", (trades24.reduce((a, b) => a + b, 0) / trades24.length).toFixed(2), "중앙값", q(trades24, 0.5), "p90", q(trades24, 0.9), "| 거래 0건 비율", ((trades24.filter((x) => x === 0).length / trades24.length) * 100).toFixed(1) + "%", "| 평균 보유(달력일)", (hold24.reduce((a, b) => a + b, 0) / Math.max(hold24.length, 1)).toFixed(0));
}
main().catch((e) => { console.error(e); process.exit(1); });
