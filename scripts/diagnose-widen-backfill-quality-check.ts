// 임시 읽기 전용 검증(추적 조회 페이지네이션 PR): 실제 수정 함수를 호출해 전체 조회 여부를 확인한다. 쓰기 없음.
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadKrTrackingRows, loadActiveStrategyStockKeys } from "@/lib/screeningActiveRows";
import { fetchAllRows } from "@/lib/supabasePagination";

async function exactCount(build: (q: any) => any): Promise<number> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const { count, error } = await build(supabaseAdmin.from("screening_results").select("*", { count: "exact", head: true }));
  if (error) throw new Error(error.message);
  return count as number;
}

async function main() {
  console.log("== A. KR 추적 대상 ==");
  const oldQ = await supabaseAdmin.from("screening_results").select("id, stock_code, status").in("status", ["active", "price_anomaly"]).eq("market", "KR");
  const oldRows = oldQ.data ?? [];
  console.log("수정 전 방식(range 없음) 반환 행:", oldRows.length, "/ 종목코드", new Set(oldRows.map((r) => r.stock_code)).size);
  const exactKr = await exactCount((q) => q.in("status", ["active", "price_anomaly"]).eq("market", "KR"));
  const t0 = Date.now();
  const rows = await loadKrTrackingRows();
  console.log("수정 후 loadKrTrackingRows:", rows.length, "건 / 종목코드", new Set(rows.map((r) => r.stock_code)).size, "개 / DB 정확 건수", exactKr, "/ 일치", rows.length === exactKr, "/ id 중복", rows.length - new Set(rows.map((r) => r.id)).size, `/ ${Date.now() - t0}ms`);
  const byStatus: Record<string, number> = {}; for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  console.log("상태별:", JSON.stringify(byStatus));

  console.log("== B. 활성 (전략,종목) 키 중복 확인 ==");
  const oldDup = await supabaseAdmin.from("screening_results").select("strategy_id, stock_code").eq("status", "active");
  console.log("수정 전 방식 반환 행:", (oldDup.data ?? []).length);
  const exactActive = await exactCount((q) => q.eq("status", "active"));
  const keys = await loadActiveStrategyStockKeys();
  console.log("수정 후 loadActiveStrategyStockKeys():", keys.size, "키 / DB active 행(정확)", exactActive, "/ 일치", keys.size === exactActive);
  const { data: peg } = await supabaseAdmin.from("strategies").select("id").eq("rule_type", "peg_lynch").eq("market", "KR");
  const pegIds = (peg ?? []).map((s) => s.id as string);
  const exactPeg = await exactCount((q) => q.eq("status", "active").in("strategy_id", pegIds));
  const pegKeys = await loadActiveStrategyStockKeys(pegIds);
  console.log("펀더멘털(peg_lynch 5행) 한정:", pegKeys.size, "키 / DB 정확", exactPeg, "/ 일치", pegKeys.size === exactPeg);

  console.log("== C. 같은 유형 위험 후보 실측(행 수) ==");
  const cap = async (label: string, q: PromiseLike<{ data: unknown[] | null }>, exact: number) => { const { data } = await q; console.log(label, "반환", (data ?? []).length, "/ 정확", exact, (data ?? []).length < exact ? "← 잘림" : ""); };
  const exPaperKr = await exactCount((q) => q.eq("status", "active").eq("market", "KR"));
  await cap("paper-trade KR 후보(active, KR, range 없음):", supabaseAdmin.from("screening_results").select("id").eq("status", "active").eq("market", "KR"), exPaperKr);
  const exPaperUs = await exactCount((q) => q.eq("status", "active").eq("market", "US"));
  await cap("paper-trade/US 추적(active, US, range 없음):", supabaseAdmin.from("screening_results").select("id").eq("status", "active").eq("market", "US"), exPaperUs);
  const { data: stratRows } = await supabaseAdmin.from("strategies").select("id, rule_type");
  const opIds = (stratRows ?? []).filter((s) => ["ma_cross", "peg_lynch", "reversal_breakout_v2"].includes(s.rule_type)).map((s) => s.id as string);
  const exOps = await exactCount((q) => q.in("strategy_id", opIds));
  await cap("전략 관리 '성과 비교'(운영 전략 id, range(0,4999)):", supabaseAdmin.from("screening_results").select("id").in("strategy_id", opIds).range(0, 4999), exOps);
  const { count: snaps } = await supabaseAdmin.from("paper_daily_snapshots").select("*", { count: "exact", head: true });
  console.log("paper_daily_snapshots 행:", snaps, "(하루 +6행, 1,000행 도달까지", Math.ceil((1000 - (snaps ?? 0)) / 6), "일)");
  const { count: sbs } = await supabaseAdmin.from("strategy_backtest_summary").select("*", { count: "exact", head: true });
  const { count: bms } = await supabaseAdmin.from("benchmark_summary").select("*", { count: "exact", head: true });
  console.log("strategy_backtest_summary 행:", sbs, "/ benchmark_summary 행:", bms);
  const closedByStrategy = await fetchAllRows<{ strategy_id: string }>((from, to) => supabaseAdmin.from("screening_results").select("strategy_id").in("status", ["stopped", "profited"]).in("strategy_id", opIds).order("id").range(from, to));
  const perStrategy: Record<string, number> = {}; for (const r of closedByStrategy) perStrategy[r.strategy_id] = (perStrategy[r.strategy_id] ?? 0) + 1;
  console.log("운영 전략별 종료 행 수 최대:", Math.max(...Object.values(perStrategy)));
}
main().catch((e) => { console.error(e); process.exit(1); });
