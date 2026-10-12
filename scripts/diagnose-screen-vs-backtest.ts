/** [임시 조사 — 병합 금지, 읽기 전용] 스크리닝 vs 백테스트 규칙 일치 확인용 실측(손절/익절 %, 장중가 판정 차이, 재등록 빈도). */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchAllRows } from "@/lib/supabasePagination";
import { loadAllStockSeriesFromParquet } from "@/lib/stockDailyPricesStorage";
import { loadAppliedAdjustments } from "@/lib/stockPriceAdjustmentsStorage";
import { computeReversalBreakoutStates } from "@/lib/reversalBreakout";
import { computeSMA } from "@/lib/sma";
import { computeTrailingAvgTradingValue } from "@/lib/pitUniverse";

interface R { id: string; strategy_id: string; stock_code: string; market: string; signal_price: number; entry_price: number; stop_loss_price: number; take_profit_price: number; matched_at: string; closed_at: string | null; status: string; score: number | null }
const kst = (iso: string): string => new Date(Date.parse(iso) + 9 * 3600e3).toISOString().slice(0, 10);
const med = (a: number[]): number => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };

async function main(): Promise<void> {
  const { data: strategies } = await supabaseAdmin.from("strategies").select("id, name, rule_type, market, rule_params");
  const st = new Map((strategies ?? []).map((s) => [s.id as string, s]));
  for (const s of strategies ?? []) console.log(`STRATEGY ${s.rule_type} ${s.market} id=${String(s.id).slice(0, 8)} name=${s.name} rule_params=${JSON.stringify(s.rule_params)}`);
  const rows = await fetchAllRows<R>((from, to) => supabaseAdmin.from("screening_results").select("id, strategy_id, stock_code, market, signal_price, entry_price, stop_loss_price, take_profit_price, matched_at, closed_at, status, score").gte("matched_at", "2026-08-01T00:00:00Z").order("id").range(from, to));
  console.log(`2026-08-01 이후 행 ${rows.length}`);
  // (b) 손절/익절 비율
  const pcts = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const rt = `${st.get(r.strategy_id)?.rule_type}:${r.market}`;
    const k = `손절 ${((1 - r.stop_loss_price / r.entry_price) * 100).toFixed(1)}% / 익절 ${((r.take_profit_price / r.entry_price - 1) * 100).toFixed(1)}%`;
    const m = pcts.get(rt) ?? new Map<string, number>(); m.set(k, (m.get(k) ?? 0) + 1); pcts.set(rt, m);
  }
  for (const [rt, m] of pcts) console.log(`PCT ${rt}: ${JSON.stringify(Object.fromEntries([...m].sort((a, b) => b[1] - a[1]).slice(0, 4)))}`);
  // (e) 보유기간(종료 행)
  const hold = new Map<string, number[]>();
  for (const r of rows) if (r.closed_at) { const k = `${st.get(r.strategy_id)?.rule_type}:${r.market}:${r.status}`; (hold.get(k) ?? hold.set(k, []).get(k)!).push((Date.parse(r.closed_at) - Date.parse(r.matched_at)) / 86400e3); }
  for (const [k, v] of hold) console.log(`HOLD ${k}: n=${v.length} 중앙 ${med(v).toFixed(1)}일 최대 ${Math.max(...v).toFixed(0)}일`);
  const act = new Map<string, number>();
  for (const r of rows.filter((x) => x.status === "active")) { const k = `${st.get(r.strategy_id)?.rule_type}:${r.market}`; act.set(k, (act.get(k) ?? 0) + 1); }
  console.log(`ACTIVE(2026-08-01 이후 생성) ${JSON.stringify(Object.fromEntries(act))}`);
  // (d) 재등록
  const byKey = new Map<string, R[]>();
  for (const r of rows.filter((x) => x.market === "KR")) (byKey.get(`${r.strategy_id}:${r.stock_code}`) ?? byKey.set(`${r.strategy_id}:${r.stock_code}`, []).get(`${r.strategy_id}:${r.stock_code}`)!).push(r);
  const rep = new Map<string, { keys: number; multi: number; rows: number; re5: number }>();
  for (const [k, list] of byKey) {
    const rt = String(st.get(k.split(":")[0])?.rule_type);
    const e = rep.get(rt) ?? { keys: 0, multi: 0, rows: 0, re5: 0 };
    e.keys++; e.rows += list.length; if (list.length > 1) e.multi++;
    const s = list.sort((a, b) => a.matched_at.localeCompare(b.matched_at));
    for (let i = 1; i < s.length; i++) if (s[i - 1].closed_at && (Date.parse(s[i].matched_at) - Date.parse(s[i - 1].closed_at!)) / 86400e3 <= 5) e.re5++;
    rep.set(rt, e);
  }
  for (const [rt, e] of rep) console.log(`REENTRY KR ${rt}: (전략,종목) ${e.keys}쌍 중 2행 이상 ${e.multi}쌍, 총 ${e.rows}행, 직전 종료 후 5일 이내 재등록 ${e.re5}건`);
  // (c) 장중가 판정
  const adjustments = await loadAppliedAdjustments();
  const series = await loadAllStockSeriesFromParquet(2023, 2026, adjustments);
  const stats: Record<string, { n: number; noBar: number; priceEq: number; priceDiffMedPct: number[]; closeTrue: number }> = {};
  for (const r of rows.filter((x) => x.market === "KR")) {
    const rt = String(st.get(r.strategy_id)?.rule_type);
    if (rt !== "ma_cross" && rt !== "reversal_breakout_v2") continue;
    const s = (stats[rt] ??= { n: 0, noBar: 0, priceEq: 0, priceDiffMedPct: [], closeTrue: 0 });
    s.n++;
    const d = kst(r.matched_at);
    const bars = series.get(r.stock_code);
    const i = bars ? bars.findIndex((b) => b.tradeDate === d) : -1;
    if (!bars || i < 0) { s.noBar++; continue; }
    const diff = (r.signal_price / bars[i].closePrice - 1) * 100;
    s.priceDiffMedPct.push(Math.abs(diff));
    if (Math.abs(diff) < 0.01) s.priceEq++;
    const sub = bars.slice(0, i + 1);
    if (rt === "reversal_breakout_v2") {
      const states = computeReversalBreakoutStates(sub.map((b) => ({ date: b.tradeDate, open: b.openPrice, close: b.closePrice, volume: b.volume })), 0.9);
      if (states[states.length - 1] === true) s.closeTrue++;
    } else {
      const closes = sub.map((b) => b.closePrice);
      const a = computeSMA(closes, 5), l = computeSMA(closes, 20);
      const n = closes.length - 1;
      if (a[n] !== undefined && l[n] !== undefined && a[n - 1] !== undefined && l[n - 1] !== undefined && a[n]! > l[n]! && !(a[n - 1]! > l[n - 1]!)) s.closeTrue++;
    }
  }
  for (const [rt, s] of Object.entries(stats)) console.log(`INTRADAY ${rt}: 행 ${s.n}, Parquet에 신호일 봉 없음 ${s.noBar}, 신호가=종가(±0.01%) ${s.priceEq}, |신호가/종가-1| 중앙 ${med(s.priceDiffMedPct).toFixed(2)}%, 신호일 종가 기준으로도 신호 유지 ${s.closeTrue}/${s.n - s.noBar}${rt === "ma_cross" ? " (구 규칙 5/20 골든크로스 기준)" : ""}`);

  // (f) 종목 범위: 신호일 기준 백테스트 유니버스(시총 5천억·20일 평균 거래대금 5억) 충족 비율
  const univ: Record<string, { n: number; noBar: number; cap5000: number; tv5: number; both: number; price1000: number; capLt500: number }> = {};
  const tvCache = new Map<string, Float64Array>();
  for (const r of rows.filter((x) => x.market === "KR")) {
    const rt = String(st.get(r.strategy_id)?.rule_type);
    const u = (univ[rt] ??= { n: 0, noBar: 0, cap5000: 0, tv5: 0, both: 0, price1000: 0, capLt500: 0 });
    u.n++;
    const d = kst(r.matched_at);
    const bars = series.get(r.stock_code);
    const i = bars ? bars.findIndex((b) => b.tradeDate === d) : -1;
    if (!bars || i < 0) { u.noBar++; continue; }
    let tv = tvCache.get(r.stock_code);
    if (!tv) { tv = computeTrailingAvgTradingValue(bars, 20); tvCache.set(r.stock_code, tv); }
    const capOk = bars[i].marketCapEok >= 5000;
    const tvOk = tv[i] >= 5e8;
    if (capOk) u.cap5000++;
    if (tvOk) u.tv5++;
    if (capOk && tvOk) u.both++;
    if (bars[i].closePrice >= 1000) u.price1000++;
    if (bars[i].marketCapEok < 500) u.capLt500++;
  }
  for (const [rt, u] of Object.entries(univ)) console.log(`UNIVERSE KR ${rt}: 행 ${u.n}(봉 없음 ${u.noBar}) 중 시총≥5천억 ${u.cap5000}, 20일평균거래대금≥5억 ${u.tv5}, 둘 다 ${u.both}, 종가≥1,000원 ${u.price1000}, 시총<500억 ${u.capLt500}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
