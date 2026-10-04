/**
 * 디스포저블 검증(읽기 전용, DB 쓰기 없음): 액면조정 방어 로직의 전후 값 비교.
 * 1) 중앙첨단소재 추적 행(가짜 +800%대) 보정 전후 2) 이벤트 있는 종목 3건+ 보정 전후(가상 진입)
 * 3) 이벤트 없는 추적 행 5건 회귀(값이 전혀 안 바뀌는지).
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadAppliedAdjustmentsForCodes } from "@/lib/stockPriceAdjustmentsStorage";
import { adjustPrice, describeFactor, getCumulativeFactor } from "@/lib/corporateActionGuard";
import { evaluateTrackingStatus } from "@/lib/backtest";
import { computeCostAdjustedReturnPct } from "@/lib/transactionCost";
import { downloadYearPrices, type StockDailyPriceRow } from "@/lib/stockDailyPricesStorage";

interface Row {
  id: string;
  stock_code: string;
  stock_name: string;
  entry_price: number;
  stop_loss_price: number;
  take_profit_price: number;
  current_price: number;
  return_pct: number;
  status: string;
  matched_at: string;
  closed_at: string | null;
}

function recompute(row: Row, adj: Map<string, { eventDate: string; factor: number }[]>, asOf: string): { factor: number; status: string; returnPct: number } {
  const factor = getCumulativeFactor(row.stock_code, row.matched_at.slice(0, 10), asOf, adj);
  const status = evaluateTrackingStatus(row.current_price, adjustPrice(row.stop_loss_price, factor), adjustPrice(row.take_profit_price, factor));
  const returnPct = computeCostAdjustedReturnPct(adjustPrice(row.entry_price, factor), row.current_price, asOf, "KR") * 100;
  return { factor, status, returnPct };
}

async function main(): Promise<void> {
  const cols = "id,stock_code,stock_name,entry_price,stop_loss_price,take_profit_price,current_price,return_pct,status,matched_at,closed_at";
  const { data: jun, error: e1 } = await supabaseAdmin.from("screening_results").select(cols).like("stock_name", "%중앙첨단소재%");
  if (e1) throw new Error(e1.message);
  const { data: active, error: e2 } = await supabaseAdmin.from("screening_results").select(cols).eq("status", "active").eq("market", "KR").limit(400);
  if (e2) throw new Error(e2.message);
  const junRows = (jun ?? []) as Row[];
  const activeRows = (active ?? []) as Row[];
  const adj = await loadAppliedAdjustmentsForCodes([...junRows, ...activeRows].map((r) => r.stock_code));

  console.log("[1] 중앙첨단소재 추적 행 — 보정 전(저장값) / 보정 후(방어 로직)");
  for (const r of junRows) {
    const asOf = (r.closed_at ?? new Date().toISOString()).slice(0, 10);
    const a = recompute(r, adj, asOf);
    console.log(
      `  ${r.stock_code} 진입 ${r.matched_at.slice(0, 10)} 진입가 ${r.entry_price} 현재가 ${r.current_price} | 전: ${r.status} ${Number(r.return_pct).toFixed(1)}% | ` +
        `후: 계수 ${a.factor}(${describeFactor(a.factor)}) 조정진입가 ${adjustPrice(r.entry_price, a.factor)} → ${a.status} ${a.returnPct.toFixed(1)}%`
    );
  }

  // 이벤트가 있는 종목(최근 applied 이벤트) 가상 진입: 이벤트 직전 거래일 종가에 진입, 이벤트일 종가로 평가.
  const { data: evs, error: e3 } = await supabaseAdmin
    .from("stock_price_adjustment_events")
    .select("stock_code,event_date,adjustment_factor")
    .eq("status", "applied")
    .gte("event_date", "2026-09-20")
    .order("event_date", { ascending: false })
    .limit(8);
  if (e3) throw new Error(e3.message);
  console.log("\n[2] 이벤트 있는 종목 — 가상 진입(이벤트 전 거래일 종가) 후 이벤트일 평가: 보정 전 / 후 수익률");
  const evAdj = await loadAppliedAdjustmentsForCodes((evs ?? []).map((e) => e.stock_code));
  // 소형주는 hot 표에 없으므로(좁은 기준) 올해 Parquet(전 종목)에서 읽는다.
  const rows2026 = await downloadYearPrices(2026);
  const byCode2026 = new Map<string, StockDailyPriceRow[]>();
  for (const r of rows2026) (byCode2026.get(r.stockCode) ?? byCode2026.set(r.stockCode, []).get(r.stockCode)!).push(r);
  let shown = 0;
  for (const e of evs ?? []) {
    if (shown >= 5) break;
    const series = (byCode2026.get(e.stock_code) ?? []).sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
    const i = series.findIndex((r) => r.tradeDate >= e.event_date);
    if (i < 1) continue;
    const prev = series[i - 1];
    const eventDay = series[i];
    const factor = getCumulativeFactor(e.stock_code, prev.tradeDate, eventDay.tradeDate, evAdj);
    const rawRet = computeCostAdjustedReturnPct(prev.closePrice, eventDay.closePrice, eventDay.tradeDate, "KR") * 100;
    const adjRet = computeCostAdjustedReturnPct(adjustPrice(prev.closePrice, factor), eventDay.closePrice, eventDay.tradeDate, "KR") * 100;
    console.log(`  ${e.stock_code} ${e.event_date} ${describeFactor(factor)} | 진입가 ${prev.closePrice} → 평가가 ${eventDay.closePrice} | 전 ${rawRet.toFixed(1)}% / 후 ${adjRet.toFixed(1)}%`);
    shown++;
  }

  // 이벤트 없는 active 행 5건 회귀: 저장된 return_pct와 방어 로직 재계산이 같은지(현재가·진입가가 저장값 그대로라면 동일해야 한다).
  console.log("\n[3] 회귀 확인 — 이벤트 없는 추적 행 5건: 저장 return_pct vs 방어 로직 재계산");
  const plain = activeRows.filter((r) => (adj.get(r.stock_code) ?? []).every((a) => a.eventDate <= r.matched_at.slice(0, 10))).slice(0, 5);
  for (const r of plain) {
    const asOf = new Date().toISOString().slice(0, 10);
    const a = recompute(r, adj, asOf);
    // 저장 return_pct는 갱신 시점 날짜의 거래비용 기준이라 오늘 날짜로 재계산하면 세율 변경이 없는 한 같다.
    console.log(`  ${r.stock_code} ${r.stock_name} 계수 ${a.factor} | 저장 ${Number(r.return_pct).toFixed(6)}% / 재계산 ${a.returnPct.toFixed(6)}% | 상태 저장 ${r.status} / 재계산 ${a.status} | ${Math.abs(Number(r.return_pct) - a.returnPct) < 1e-6 ? "동일" : "차이"}`);
  }
  console.log(`  (이벤트 없는 active 행 ${plain.length}건 표본, 후보 풀 ${activeRows.length}건)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
