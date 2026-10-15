/**
 * [임시 점검 — 병합 금지, 읽기 전용] 10/15 14:30 스크리닝 추적 단계에서 조정계수(분할/병합) 5종목이 잘못 종료됐는지 확인.
 * 읽는 것: screening_results(5개 종목), stock_price_adjustment_events(5개 종목), paper_positions/paper_trades(소량). 쓰기 없음.
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const CODES = ["014160", "017650", "038060", "032080", "033340"];
const TODAY_START_UTC = "2026-10-14T15:00:00Z"; // 2026-10-15 00:00 KST

async function main(): Promise<void> {
  console.log(`조정계수 5종목 종료 행 점검 시작(읽기 전용): ${new Date().toISOString()}`);

  const strategies = await supabaseAdmin.from("strategies").select("id, name, rule_type, market");
  if (strategies.error) throw new Error(strategies.error.message);
  const strat = new Map((strategies.data ?? []).map((s) => [s.id as string, s]));

  const events = await supabaseAdmin
    .from("stock_price_adjustment_events")
    .select("stock_code, event_date, price_ratio, shares_ratio, adjustment_factor, status, detected_at")
    .in("stock_code", CODES)
    .gte("event_date", "2026-09-01")
    .order("event_date");
  if (events.error) throw new Error(events.error.message);
  console.log(`[이벤트] ${(events.data ?? []).length}건`);
  for (const e of events.data ?? []) console.log(`  ${e.stock_code} ${e.event_date} 가격비 ${e.price_ratio} 주식수비 ${e.shares_ratio} 계수 ${e.adjustment_factor} ${e.status} 등록시각 ${e.detected_at}`);

  const rows = await supabaseAdmin
    .from("screening_results")
    .select("id, strategy_id, stock_code, stock_name, status, entry_price, stop_loss_price, take_profit_price, current_price, return_pct, matched_at, closed_at, signal_details")
    .in("stock_code", CODES)
    .eq("market", "KR")
    .order("closed_at", { ascending: false, nullsFirst: true });
  if (rows.error) throw new Error(rows.error.message);
  const all = rows.data ?? [];
  const statusCount = new Map<string, number>();
  for (const r of all) statusCount.set(`${r.stock_code}:${r.status}`, (statusCount.get(`${r.stock_code}:${r.status}`) ?? 0) + 1);
  console.log(`[행 상태] ${[...statusCount].sort().map(([k, v]) => `${k}=${v}`).join(", ")}`);

  const closedToday = all.filter((r) => r.closed_at && r.closed_at >= TODAY_START_UTC && (r.status === "stopped" || r.status === "profited"));
  console.log(`[오늘 종료 행] ${closedToday.length}건`);
  const ids = new Set<string>();
  for (const r of closedToday) {
    ids.add(r.id as string);
    const evs = (events.data ?? []).filter((e) => e.status === "applied" && String(e.event_date) > String(r.matched_at).slice(0, 10));
    const factor = evs.reduce((a, e) => a * Number(e.adjustment_factor), 1);
    const entry = Number(r.entry_price), stop = Number(r.stop_loss_price), take = Number(r.take_profit_price), cur = Number(r.current_price);
    const adjEntry = entry * factor, adjStop = stop * factor, adjTake = take * factor;
    const adjReturn = (cur / adjEntry - 1) * 100;
    const s = strat.get(r.strategy_id as string);
    const reason = r.status === "stopped" ? "손절" : "익절";
    const wouldHit = r.status === "stopped" ? cur <= adjStop : cur >= adjTake;
    console.log(
      `  ${r.stock_code} ${r.stock_name} [${s?.rule_type ?? "?"}] ${reason} 행 ${String(r.id).slice(0, 8)} | 진입 ${entry} 손절선 ${stop} 익절선 ${take} 종료가 ${cur} (저장 수익률 ${r.return_pct}%) | ` +
        `적용 계수 누적 ${factor}(이벤트 ${evs.length}건) → 조정 후 진입 ${adjEntry.toFixed(1)} 손절선 ${adjStop.toFixed(1)} 익절선 ${adjTake.toFixed(1)} 조정 후 수익률 ${adjReturn.toFixed(2)}% | 조정 후에도 ${reason}선 도달: ${wouldHit ? "예" : "아니오(오판 가능)"} | 매칭 ${r.matched_at} 종료 ${r.closed_at}`
    );
  }
  const byStrategy = new Map<string, number>();
  for (const r of closedToday) byStrategy.set(`${strat.get(r.strategy_id as string)?.rule_type ?? "?"}/${r.status}`, (byStrategy.get(`${strat.get(r.strategy_id as string)?.rule_type ?? "?"}/${r.status}`) ?? 0) + 1);
  console.log(`[전략별 종료 행 수] ${[...byStrategy].sort().map(([k, v]) => `${k}=${v}`).join(", ")}`);

  // 모의 포지션/거래
  const positions = await supabaseAdmin.from("paper_positions").select("id, portfolio_id, stock_code, stock_name, quantity, avg_price, screening_result_id").in("stock_code", CODES);
  if (positions.error) throw new Error(positions.error.message);
  console.log(`[모의 보유 포지션(5종목)] ${(positions.data ?? []).length}건 ${(positions.data ?? []).map((p) => `${p.stock_code} ${p.quantity}주 평단 ${p.avg_price} 연결행 ${p.screening_result_id ? String(p.screening_result_id).slice(0, 8) : "-"}`).join(" | ")}`);
  const sells = await supabaseAdmin
    .from("paper_trades")
    .select("id, portfolio_id, strategy_id, stock_code, stock_name, side, quantity, price, realized_pnl, rationale, screening_result_id, traded_at")
    .eq("side", "sell")
    .gte("traded_at", TODAY_START_UTC)
    .order("traded_at");
  if (sells.error) throw new Error(sells.error.message);
  const sellRows = sells.data ?? [];
  console.log(`[오늘 모의 매도] ${sellRows.length}건`);
  for (const t of sellRows) {
    const inCodes = CODES.includes(t.stock_code as string);
    const linked = t.screening_result_id && ids.has(t.screening_result_id as string);
    console.log(`  ${t.stock_code} ${t.stock_name} ${t.quantity}주 @${t.price} 손익 ${t.realized_pnl} ${inCodes ? "★5종목" : ""}${linked ? "★오늘 종료된 5종목 행과 연결" : ""} | ${String(t.rationale).slice(0, 70)}`);
  }
  console.log(`[판정] 5종목 중 오늘 모의 매도에 포함: ${sellRows.filter((t) => CODES.includes(t.stock_code as string)).length}건`);
  console.log("완료");
}
main().catch((e) => { console.error(e); process.exit(1); });
