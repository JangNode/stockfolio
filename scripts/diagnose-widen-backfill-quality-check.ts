// 임시 읽기 전용 검증(1,000건 상한 후속 PR). 쓰기 없음.
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadActiveScreeningResults, loadUsTrackingRows, loadActiveStrategyStockKeys } from "@/lib/screeningActiveRows";
import { fetchAllRows } from "@/lib/supabasePagination";
import { computeScreeningResultStats } from "@/lib/screeningResultStats";
import { selectBuyCandidates, type ScreeningCandidateRow, type TradeConditions } from "@/lib/paperTrading";
import type { Market } from "@/lib/market";

type R = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
async function exact(build: (q: any) => any): Promise<number> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const { count, error } = await build(supabaseAdmin.from("screening_results").select("*", { count: "exact", head: true }));
  if (error) throw new Error(error.message);
  return count as number;
}
const f = (n: number | null | undefined) => (n === null || n === undefined ? "-" : n.toFixed(2));

async function main() {
  console.log("== A. 모의투자 매수 후보 원천(활성 스크리닝 결과) ==");
  const strategies = (await fetchAllRows<R>((a, b) => supabaseAdmin.from("strategies").select("id, rule_type, market, user_id, created_at").order("id").range(a, b)));
  const ruleOf = new Map(strategies.map((s) => [s.id as string, s.rule_type as string]));
  const build = (rows: R[], market: Market): ScreeningCandidateRow[] => {
    const mapped = rows.filter((r) => ruleOf.has(r.strategy_id)).map((r) => ({ screeningResultId: r.id, stockCode: r.stock_code, stockName: r.stock_name, ruleType: ruleOf.get(r.strategy_id) as ScreeningCandidateRow["ruleType"], returnPct: r.return_pct, currentPrice: r.current_price, market: r.market as Market, exchange: (r.exchange as string | null) ?? null }));
    const seen = new Set<string>(); const out: typeof mapped = [];
    for (const r of mapped) { const k = `${r.stockCode}:${r.ruleType}`; if (seen.has(k)) continue; seen.add(k); out.push(r); }
    void market; return out;
  };
  const { data: ports } = await supabaseAdmin.from("paper_portfolios").select("id, style, market, cash");
  const { data: acts } = await supabaseAdmin.from("paper_strategies").select("style, entry_conditions, exit_conditions, stock_selection_criteria").eq("is_active", true);
  const { data: positions } = await supabaseAdmin.from("paper_positions").select("portfolio_id, stock_code, market");
  for (const market of ["KR", "US"] as Market[]) {
    const oldRes = await supabaseAdmin.from("screening_results").select("id, stock_code, stock_name, strategy_id, return_pct, current_price, market, exchange").eq("status", "active").eq("market", market);
    const oldRows = (oldRes.data ?? []) as R[];
    const newRows = (await loadActiveScreeningResults(market)) as unknown as R[];
    const ex = await exact((q) => q.eq("status", "active").eq("market", market));
    console.log(`[${market}] 수정 전 ${oldRows.length}건 → 수정 후 ${newRows.length}건 / DB 정확 ${ex} / 일치 ${newRows.length === ex} / id 중복 ${newRows.length - new Set(newRows.map((r) => r.id)).size}`);
    const oc = build(oldRows, market), nc = build(newRows, market);
    console.log(`  후보(종목+전략유형 중복 제거) 수정 전 ${oc.length} → 수정 후 ${nc.length}`);
    const typeCount = (c: ScreeningCandidateRow[]) => JSON.stringify(c.reduce((m: Record<string, number>, r) => ((m[r.ruleType] = (m[r.ruleType] ?? 0) + 1), m), {}));
    console.log("  유형별 전:", typeCount(oc), "후:", typeCount(nc));
    for (const p of (ports ?? []).filter((x) => x.market === market && ["conservative", "aggressive", "surge_stock"].includes(x.style))) {
      const a = (acts ?? []).find((x) => x.style === p.style); if (!a) continue;
      const cond = { entry_conditions: a.entry_conditions, exit_conditions: a.exit_conditions, stock_selection_criteria: a.stock_selection_criteria } as unknown as TradeConditions;
      const held = new Set((positions ?? []).filter((x) => x.portfolio_id === p.id).map((x) => x.stock_code as string));
      const run = (c: ScreeningCandidateRow[]) => selectBuyCandidates(p.style, cond, c, held, held.size, p.cash).map((d) => `${d.candidate.stockName}(${d.candidate.ruleType})`);
      const b4 = run(oc), af = run(nc);
      const same = JSON.stringify(b4) === JSON.stringify(af);
      console.log(`  [${p.style}:${market}] 현재 보유 ${held.size}, 현금 ${Math.round(p.cash)} → 매수 판정 전 ${b4.length}건 [${b4.join(", ")}] / 후 ${af.length}건 [${af.join(", ")}] / 동일 ${same}`);
    }
  }

  console.log("== B. 전략 관리 '전략 성과 비교' (계정별 수정 전/후) ==");
  const byUser = new Map<string, R[]>();
  for (const s of strategies.filter((x) => x.market === "KR" && ["ma_cross", "peg_lynch", "reversal_breakout_v2"].includes(x.rule_type))) { const l = byUser.get(s.user_id) ?? []; l.push(s); byUser.set(s.user_id, l); }
  let uIdx = 0;
  for (const [uid, list] of byUser) {
    uIdx++;
    list.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    const comparable: R[] = []; const seen = new Set<string>();
    for (const s of list) { if (seen.has(s.rule_type)) continue; seen.add(s.rule_type); comparable.push(s); }
    const ids = comparable.map((s) => s.id as string);
    const oldRes = await supabaseAdmin.from("screening_results").select("strategy_id, status, return_pct, matched_at").in("strategy_id", ids).range(0, 4999);
    const oldRows = (oldRes.data ?? []) as R[];
    const newRows = await fetchAllRows<R>((a, b) => supabaseAdmin.from("screening_results").select("strategy_id, status, return_pct, matched_at").in("strategy_id", ids).order("id").range(a, b));
    const statOf = (rows: R[], sid: string) => computeScreeningResultStats(rows.filter((r) => r.strategy_id === sid).map((r) => ({ status: r.status, returnPct: r.return_pct, matchedAt: r.matched_at })));
    let anyDiff = false; const lines: string[] = [];
    for (const s of comparable) {
      const o = statOf(oldRows, s.id), n = statOf(newRows, s.id);
      const diff = JSON.stringify(o) !== JSON.stringify(n); anyDiff ||= diff;
      lines.push(`    ${s.rule_type}: 전 신호 ${o.total}/진행 ${o.activeCount}/종료 ${o.closedCount}/승률 ${o.winRate === null ? "-" : f(o.winRate * 100)}/평균 ${f(o.avgReturnPct)}/중앙값 ${f(o.medianReturnPct)} → 후 ${n.total}/${n.activeCount}/${n.closedCount}/${n.winRate === null ? "-" : f(n.winRate * 100)}/${f(n.avgReturnPct)}/${f(n.medianReturnPct)} ${diff ? "← 달라짐" : "(동일)"}`);
    }
    console.log(`  계정 ${uIdx} (${uid.slice(0, 8)}): 전략 ${ids.length}개, 행 수정 전 ${oldRows.length} → 수정 후 ${newRows.length}, 값 변경 ${anyDiff}`);
    for (const l of lines) console.log(l);
  }

  console.log("== C. US 추적·중복 확인 ==");
  const exUs = await exact((q) => q.eq("status", "active").eq("market", "US"));
  const usRows = await loadUsTrackingRows();
  const usKeys = await loadActiveStrategyStockKeys(undefined, "US");
  console.log(`US 추적 loadUsTrackingRows ${usRows.length} / DB 정확 ${exUs} / 일치 ${usRows.length === exUs} | US 활성 키 ${usKeys.size} / 일치 ${usKeys.size === exUs} | 종목코드 ${new Set(usRows.map((r) => r.stock_code)).size}개`);
}
main().catch((e) => { console.error(e); process.exit(1); });
