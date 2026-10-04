/**
 * 디스포저블 진단(읽기 전용, DB 쓰기 없음): 액면분할·병합이 추적(screening_results)·AI 모의투자
 * (paper_positions/paper_trades)에 미친 영향 범위 점검.
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";

interface EventRow {
  stock_code: string;
  event_date: string;
  status: string;
  low_confidence_reason: string | null;
  adjustment_factor: number;
  price_ratio: number;
  shares_ratio: number;
  detected_at: string;
}
interface TrackRow {
  id: string;
  strategy_id: string;
  stock_code: string;
  stock_name: string;
  entry_price: number;
  current_price: number;
  return_pct: number;
  status: string;
  matched_at: string;
  closed_at: string | null;
  market: string;
}

async function pageAll<T>(table: string, columns: string, filter?: (q: any) => any): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    let q = supabaseAdmin.from(table).select(columns).range(from, from + 999);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

const d10 = (s: string | null): string => (s ?? "").slice(0, 10);

async function main(): Promise<void> {
  const events = await pageAll<EventRow>(
    "stock_price_adjustment_events",
    "stock_code,event_date,status,low_confidence_reason,adjustment_factor,price_ratio,shares_ratio,detected_at"
  );
  const byCode = new Map<string, EventRow[]>();
  for (const e of events) (byCode.get(e.stock_code) ?? byCode.set(e.stock_code, []).get(e.stock_code)!).push(e);
  const latestEvent = events.map((e) => e.event_date).sort().pop();
  const latestDetected = events.map((e) => e.detected_at).sort().pop();
  console.log(`이벤트 ${events.length}건, 가장 최근 이벤트일 ${latestEvent}, 마지막 저장(detected_at) ${latestDetected}`);
  const recent = events.filter((e) => e.event_date >= "2026-09-01").sort((a, b) => a.event_date.localeCompare(b.event_date));
  console.log(`[2026-09 이후 이벤트] ${recent.length}건`);
  for (const e of recent) console.log(`  ${e.stock_code} ${e.event_date} ${e.status}${e.low_confidence_reason ? `(${e.low_confidence_reason})` : ""} 가격비 ${Number(e.price_ratio).toFixed(3)} 주식수비 ${Number(e.shares_ratio).toFixed(3)} 계수 ${Number(e.adjustment_factor).toFixed(4)}`);

  // 중앙첨단소재.
  const jungang = await pageAll<TrackRow>(
    "screening_results",
    "id,strategy_id,stock_code,stock_name,entry_price,current_price,return_pct,status,matched_at,closed_at,market",
    (q) => q.like("stock_name", "%중앙첨단소재%")
  );
  console.log(`\n[중앙첨단소재 screening_results] ${jungang.length}건`);
  for (const r of jungang) {
    const ev = (byCode.get(r.stock_code) ?? []).map((e) => `${e.event_date} ${e.status}(계수 ${Number(e.adjustment_factor).toFixed(3)})`).join("; ") || "이벤트 없음";
    console.log(`  ${r.stock_code} ${r.status} 진입 ${d10(r.matched_at)} 진입가 ${r.entry_price} 현재가 ${r.current_price} 수익률 ${Number(r.return_pct).toFixed(1)}% 종료 ${d10(r.closed_at)} | 이벤트: ${ev}`);
  }

  // 추적 행 전체 중 진입~종료(또는 현재) 사이에 이벤트가 있는 행.
  const tracks = await pageAll<TrackRow>(
    "screening_results",
    "id,strategy_id,stock_code,stock_name,entry_price,current_price,return_pct,status,matched_at,closed_at,market",
    (q) => q.eq("market", "KR")
  );
  const affected: { row: TrackRow; evs: EventRow[] }[] = [];
  for (const r of tracks) {
    const evs = (byCode.get(r.stock_code) ?? []).filter(
      (e) => e.event_date > d10(r.matched_at) && (r.closed_at === null || e.event_date <= d10(r.closed_at))
    );
    if (evs.length > 0) affected.push({ row: r, evs });
  }
  const show = (label: string, list: typeof affected): void => {
    console.log(`\n[${label}] ${list.length}건`);
    for (const { row: r, evs } of list.slice(0, 60)) {
      console.log(
        `  ${r.stock_code} ${r.stock_name} ${r.status} 진입 ${d10(r.matched_at)} 종료 ${d10(r.closed_at)} 진입가 ${r.entry_price} 현재가 ${r.current_price} 수익률 ${Number(r.return_pct).toFixed(1)}% | ` +
          evs.map((e) => `${e.event_date} ${e.status}(계수 ${Number(e.adjustment_factor).toFixed(3)})`).join("; ")
      );
    }
  };
  show("추적 중(active) + 진입 후 이벤트 있음", affected.filter((a) => a.row.status === "active"));
  show("종료(stopped/profited/price_unavailable) + 보유기간 중 이벤트 있음", affected.filter((a) => a.row.status !== "active"));

  // 이벤트 미등록 의심: 진입가 대비 현재가 비율이 극단적인 행.
  const extreme = tracks.filter((r) => r.entry_price > 0 && (r.current_price / r.entry_price >= 3 || r.current_price / r.entry_price <= 0.34));
  console.log(`\n[진입가 대비 현재가 ≥3배 또는 ≤0.34배 행] ${extreme.length}건`);
  for (const r of extreme.slice(0, 40)) {
    const evs = (byCode.get(r.stock_code) ?? []).filter((e) => e.event_date > d10(r.matched_at));
    console.log(`  ${r.stock_code} ${r.stock_name} ${r.status} 진입 ${d10(r.matched_at)} 진입가 ${r.entry_price} 현재가 ${r.current_price} 수익률 ${Number(r.return_pct).toFixed(1)}% | 진입 후 이벤트 ${evs.length ? evs.map((e) => `${e.event_date} ${e.status}`).join("; ") : "없음"}`);
  }

  // 모의투자: 보유 포지션과 청산 거래.
  const positions = await pageAll<{ id: string; portfolio_id: string; stock_code: string; stock_name: string; quantity: number; avg_price: number; opened_at: string; screening_result_id: string | null; market: string }>(
    "paper_positions",
    "id,portfolio_id,stock_code,stock_name,quantity,avg_price,opened_at,screening_result_id,market"
  );
  console.log(`\n[모의투자 보유 포지션] ${positions.length}건`);
  for (const p of positions) {
    const evs = (byCode.get(p.stock_code) ?? []).filter((e) => e.event_date > d10(p.opened_at));
    if (evs.length > 0) {
      console.log(`  ⚠ ${p.stock_code} ${p.stock_name} ${p.quantity}주 @${p.avg_price} 진입 ${d10(p.opened_at)} | 이벤트 ${evs.map((e) => `${e.event_date} ${e.status}(계수 ${Number(e.adjustment_factor).toFixed(3)})`).join("; ")}`);
    }
  }
  const trades = await pageAll<{ id: string; stock_code: string; stock_name: string; side: string; quantity: number; price: number; amount: number; realized_pnl: number | null; rationale: string; screening_result_id: string | null; traded_at: string; market: string }>(
    "paper_trades",
    "id,stock_code,stock_name,side,quantity,price,amount,realized_pnl,rationale,screening_result_id,traded_at,market"
  );
  const buyBy = new Map<string, (typeof trades)[number]>();
  for (const t of trades) if (t.side === "buy" && t.screening_result_id) buyBy.set(`${t.stock_code}:${t.screening_result_id}`, t);
  const suspectSells: { t: (typeof trades)[number]; evs: EventRow[]; buyDate: string | null }[] = [];
  for (const t of trades.filter((x) => x.side === "sell")) {
    const buy = t.screening_result_id ? buyBy.get(`${t.stock_code}:${t.screening_result_id}`) : undefined;
    const buyDate = buy ? d10(buy.traded_at) : null;
    const evs = (byCode.get(t.stock_code) ?? []).filter((e) => (buyDate === null || e.event_date > buyDate) && e.event_date <= d10(t.traded_at));
    if (evs.length > 0) suspectSells.push({ t, evs, buyDate });
  }
  console.log(`\n[모의투자 청산 거래 중 보유기간에 이벤트가 낀 건] ${suspectSells.length}건`);
  let pnlSum = 0;
  for (const { t, evs, buyDate } of suspectSells) {
    pnlSum += Number(t.realized_pnl ?? 0);
    console.log(
      `  ${t.stock_code} ${t.stock_name} 매수 ${buyDate ?? "?"} 매도 ${d10(t.traded_at)} ${t.quantity}주 @${t.price} 금액 ${Math.round(t.amount)} 실현손익 ${Math.round(Number(t.realized_pnl ?? 0))} | ${evs.map((e) => `${e.event_date} ${e.status}(계수 ${Number(e.adjustment_factor).toFixed(3)})`).join("; ")} | ${t.rationale.slice(0, 50)}`
    );
  }
  console.log(`  실현손익 합계 ${Math.round(pnlSum)}원`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
