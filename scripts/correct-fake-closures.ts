/**
 * 디스포저블: 액면분할·병합 이벤트 때문에 가짜 익절/손절로 청산된 screening_results 행 정정.
 * 기본은 계획 출력만(쓰기 없음). CORRECT_APPLY=true이면 정정 전 행 전체를 JSON 백업(파일 + 로그)으로 남긴 뒤
 * status/closed_at/return_pct만 고친다(current_price 등 나머지 컬럼은 그대로). 되돌리려면 백업 JSON의 값으로
 * 같은 id 행을 되돌린다.
 */
import { writeFileSync } from "node:fs";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadAppliedAdjustmentsForCodes } from "@/lib/stockPriceAdjustmentsStorage";
import { adjustPrice, describeFactor, getCumulativeFactor } from "@/lib/corporateActionGuard";
import { evaluateTrackingStatus } from "@/lib/backtest";
import { computeCostAdjustedReturnPct } from "@/lib/transactionCost";
import { computeScreeningResultStats } from "@/lib/screeningResultStats";

const APPLY = process.env.CORRECT_APPLY === "true";
const BACKUP_FILE = "correction-backup.json";
const FOCUS_NAME = "중앙첨단소재";

interface Row {
  id: string;
  strategy_id: string;
  stock_code: string;
  stock_name: string;
  entry_price: number;
  stop_loss_price: number;
  take_profit_price: number;
  current_price: number;
  return_pct: number;
  status: "active" | "stopped" | "profited" | "price_unavailable" | "price_anomaly";
  matched_at: string;
  closed_at: string | null;
  market: string;
  [key: string]: unknown;
}

const d10 = (s: string): string => s.slice(0, 10);

async function main(): Promise<void> {
  const { data, error } = await supabaseAdmin.from("screening_results").select("*").eq("market", "KR").in("status", ["stopped", "profited"]).not("closed_at", "is", null);
  if (error) throw new Error(error.message);
  const closed = (data ?? []) as Row[];
  const adj = await loadAppliedAdjustmentsForCodes(Array.from(new Set(closed.map((r) => r.stock_code))));

  interface Plan { row: Row; factor: number; newStatus: string; newReturnPct: number; events: string }
  const candidates: Plan[] = [];
  for (const r of closed) {
    const events = (adj.get(r.stock_code) ?? []).filter((a) => a.eventDate > d10(r.matched_at) && a.eventDate <= d10(r.closed_at!));
    if (events.length === 0) continue;
    const factor = getCumulativeFactor(r.stock_code, d10(r.matched_at), d10(r.closed_at!), adj);
    const newStatus = evaluateTrackingStatus(r.current_price, adjustPrice(r.stop_loss_price, factor), adjustPrice(r.take_profit_price, factor));
    const newReturnPct = computeCostAdjustedReturnPct(adjustPrice(r.entry_price, factor), r.current_price, d10(r.closed_at!), "KR") * 100;
    candidates.push({ row: r, factor, newStatus, newReturnPct, events: events.map((e) => `${e.eventDate}(${describeFactor(e.factor)})`).join("; ") });
  }
  const targets = candidates.filter((c) => c.newStatus !== c.row.status);
  console.log(`이벤트가 보유기간에 낀 종료 행 ${candidates.length}건 중 정정 대상(조정 후 판정이 달라짐) ${targets.length}건`);
  for (const c of candidates) {
    const isTarget = targets.includes(c);
    console.log(
      `  ${isTarget ? "[대상]" : "[유지]"} ${c.row.stock_code} ${c.row.stock_name}${c.row.stock_name.includes(FOCUS_NAME) ? "" : " ★중앙첨단소재 외"} 전략 ${c.row.strategy_id.slice(0, 8)} ` +
        `진입 ${d10(c.row.matched_at)} 종료 ${d10(c.row.closed_at!)} | 이벤트 ${c.events} | ${c.row.status} ${Number(c.row.return_pct).toFixed(1)}% → ${c.newStatus} ${c.newReturnPct.toFixed(1)}%`
    );
  }

  // 집계 변화(전략별 closed 표본 승률/평균).
  const strategyIds = Array.from(new Set(targets.map((t) => t.row.strategy_id)));
  for (const sid of strategyIds) {
    const { data: all } = await supabaseAdmin.from("screening_results").select("id,status,return_pct,matched_at").eq("strategy_id", sid);
    const rows = (all ?? []) as { id: string; status: Row["status"]; return_pct: number; matched_at: string }[];
    const toStat = (list: typeof rows) => list.map((r) => ({ status: r.status, returnPct: r.return_pct, matchedAt: r.matched_at }));
    const before = computeScreeningResultStats(toStat(rows));
    const fixed = new Map(targets.filter((t) => t.row.strategy_id === sid).map((t) => [t.row.id, t]));
    const after = computeScreeningResultStats(toStat(rows.map((r) => (fixed.has(r.id) ? { ...r, status: fixed.get(r.id)!.newStatus as Row["status"], return_pct: fixed.get(r.id)!.newReturnPct } : r))));
    const f = (v: number | null, pct = false): string => (v === null ? "-" : pct ? `${(v * 100).toFixed(1)}%` : `${v.toFixed(1)}%`);
    console.log(`  [집계 ${sid.slice(0, 8)}] 종료 ${before.closedCount}→${after.closedCount}건, 승률 ${f(before.winRate, true)}→${f(after.winRate, true)}, 평균수익률 ${f(before.avgReturnPct)}→${f(after.avgReturnPct)}`);
  }

  if (!APPLY) {
    console.log("\n계획 출력만(CORRECT_APPLY 미설정) — DB 쓰기 없음.");
    return;
  }
  writeFileSync(BACKUP_FILE, JSON.stringify(targets.map((t) => t.row), null, 2));
  console.log(`\n[백업 JSON ${targets.length}건 — 정정 전 행 전체]\n${JSON.stringify(targets.map((t) => t.row))}`);
  let ok = 0;
  for (const t of targets) {
    const { error: upErr } = await supabaseAdmin
      .from("screening_results")
      .update({ status: t.newStatus, closed_at: t.newStatus === "active" ? null : t.row.closed_at, return_pct: t.newReturnPct })
      .eq("id", t.row.id);
    if (upErr) console.error(`  정정 실패 ${t.row.id} ${t.row.stock_code}: ${upErr.message}`);
    else ok++;
  }
  console.log(`정정 완료 ${ok}/${targets.length}건`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
