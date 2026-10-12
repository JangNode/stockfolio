/** [임시 측정 — 병합 금지, 읽기 전용, DB 쓰기 없음] 구 규칙(5/20) active 행이 v3 신호를 막는 정도 측정. */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchAllRows } from "@/lib/supabasePagination";
import { loadAllStockSeriesFromParquet, type StockDailyPriceRow } from "@/lib/stockDailyPricesStorage";
import { loadAppliedAdjustments } from "@/lib/stockPriceAdjustmentsStorage";
import { MA_CROSS_V3_PARAMS } from "@/lib/maCrossConfig";
import { computeAvgTradingValueWon, passesKrSignalUniverse } from "@/lib/screeningSignalRules";
import { matchesEntrySignalToday, type DailyPrice, type StrategyRule } from "@/lib/backtest";

const RECENT_FROM = "2026-08-03";
const RECENT_TO = "2026-10-08";
const KIS_ROWS = 520;
const RULE: StrategyRule = { rule_type: "ma_cross", rule_params: MA_CROSS_V3_PARAMS };

const toPrices = (rows: StockDailyPriceRow[]): DailyPrice[] =>
  rows.map((r) => ({ date: r.tradeDate, open: r.openPrice, high: r.highPrice, low: r.lowPrice, close: r.closePrice, volume: r.volume, marketCapEok: r.marketCapEok, listedShares: r.listedShares }));
const kst = (iso: string): string => new Date(Date.parse(iso) + 9 * 3600e3).toISOString().slice(0, 10);
const days = (a: string, b: string): number => (Date.parse(b) - Date.parse(a)) / 86400e3;
const med = (a: number[]): number => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const q = (a: number[], p: number): number => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : NaN; };

interface Old { id: string; strategy_id: string; stock_code: string; stock_name: string; market: string; status: string; matched_at: string; closed_at: string | null; entry_price: number; current_price: number; stop_loss_price: number; take_profit_price: number; return_pct: number; signal_details: unknown }

async function main(): Promise<void> {
  const { data: strategies } = await supabaseAdmin.from("strategies").select("id, rule_type");
  const ruleOf = new Map((strategies ?? []).map((s) => [s.id as string, s.rule_type as string]));
  const rows = await fetchAllRows<Old>((from, to) =>
    supabaseAdmin.from("screening_results").select("id, strategy_id, stock_code, stock_name, market, status, matched_at, closed_at, entry_price, current_price, stop_loss_price, take_profit_price, return_pct, signal_details").eq("market", "KR").order("id").range(from, to));
  const ma = rows.filter((r) => ruleOf.get(r.strategy_id) === "ma_cross");
  const marked = (d: unknown): boolean => typeof d === "object" && d !== null && ("rule_version" in (d as object));
  const oldActive = ma.filter((r) => r.status === "active" && !marked(r.signal_details));
  console.log(`구 규칙(5/20) KR active 행 ${oldActive.length}건, 고유 종목 ${new Set(oldActive.map((r) => r.stock_code)).size}개`);

  const adjustments = await loadAppliedAdjustments();
  const series = await loadAllStockSeriesFromParquet(2010, new Date().getUTCFullYear(), adjustments);

  // 1. 현재 후보 유니버스(시총 5천억 이상 + 20일 평균 거래대금 5억 이상) 소속 — Parquet 최신 거래일 기준
  let inUniv = 0, noBar = 0;
  const univOf = new Map<string, boolean>();
  for (const r of oldActive) {
    const rows2 = series.get(r.stock_code);
    if (!rows2 || rows2.length === 0) { noBar++; univOf.set(r.id, false); continue; }
    const prices = toPrices(rows2);
    const i = prices.length - 1;
    const ok = passesKrSignalUniverse("ma_cross", rows2[i].marketCapEok, computeAvgTradingValueWon(prices, i));
    univOf.set(r.id, ok);
    if (ok) inUniv++;
  }
  const latestDate = [...series.values()].map((x) => x[x.length - 1]?.tradeDate).sort().pop();
  console.log(`[1] 새 후보 유니버스 소속: ${inUniv}/${oldActive.length}건 (Parquet 최신 거래일 ${latestDate} 기준 시총 ≥5천억·20일 평균 거래대금 ≥5억; 시세 없음 ${noBar}건)`);

  // 2. 최근 45거래일 v3 재생 신호와 겹침
  const signals: { code: string; date: string }[] = [];
  const tradingDays = new Set<string>();
  for (const [code, rows2] of series) {
    const prices = toPrices(rows2);
    for (let i = 1; i < prices.length; i++) {
      const d = prices[i].date;
      if (d < RECENT_FROM || d > RECENT_TO) continue;
      tradingDays.add(d);
      if (!passesKrSignalUniverse("ma_cross", rows2[i].marketCapEok, computeAvgTradingValueWon(prices, i))) continue;
      if (matchesEntrySignalToday(prices.slice(Math.max(0, i - KIS_ROWS + 1), i + 1), RULE)) signals.push({ code, date: d });
    }
  }
  const activeCodes = new Set(oldActive.map((r) => r.stock_code));
  const overlapNow = signals.filter((s) => activeCodes.has(s.code));
  // 신호일 기준으로 그 종목의 구 행이 실제로 active였는지(matched_at ≤ 신호일 < closed_at)
  const overlapAtDate = signals.filter((s) => ma.some((r) => !marked(r.signal_details) && r.stock_code === s.code && kst(r.matched_at) <= s.date && (!r.closed_at || kst(r.closed_at) > s.date)));
  console.log(`[2] 최근 ${tradingDays.size}거래일(${RECENT_FROM}~${RECENT_TO}) v3 재생 신호 ${signals.length}건 (고유 종목 ${new Set(signals.map((s) => s.code)).size}개)`);
  console.log(`    현재 구 규칙 active 종목과 겹침: ${overlapNow.length}건 (${((overlapNow.length / Math.max(signals.length, 1)) * 100).toFixed(1)}%), 고유 종목 ${new Set(overlapNow.map((s) => s.code)).size}개`);
  console.log(`    신호일 당시 그 종목의 구 행이 active였던 건(실제로 막혔을 건): ${overlapAtDate.length}건 (${((overlapAtDate.length / Math.max(signals.length, 1)) * 100).toFixed(1)}%)`);
  console.log(`    겹침 신호: ${JSON.stringify(overlapNow.map((s) => `${s.code}@${s.date}`))}`);

  // 3. 겹치는 종목의 구 행 분포/해소 시점
  const overlapCodes = new Set(overlapNow.map((s) => s.code));
  const ovRows = oldActive.filter((r) => overlapCodes.has(r.stock_code));
  const today = new Date().toISOString().slice(0, 10);
  const ages = ovRows.map((r) => days(kst(r.matched_at), today));
  console.log(`[3] 겹치는 종목의 구 행 ${ovRows.length}건: 등록 후 경과일 최소 ${Math.min(...ages).toFixed(0)} / 중앙 ${med(ages).toFixed(0)} / 최대 ${Math.max(...ages).toFixed(0)}일`);
  for (const r of ovRows.sort((a, b) => a.matched_at.localeCompare(b.matched_at))) {
    const toStop = (r.current_price / r.stop_loss_price - 1) * 100; // 손절선까지 남은 하락 여유(%)
    const toTake = (r.take_profit_price / r.current_price - 1) * 100; // 익절선까지 남은 상승(%)
    console.log(`    ${r.stock_code} ${r.stock_name} 등록 ${kst(r.matched_at)} (${days(kst(r.matched_at), today).toFixed(0)}일) 수익률 ${r.return_pct.toFixed(2)}% | 손절선까지 -${toStop.toFixed(1)}% | 익절선까지 +${toTake.toFixed(1)}%`);
  }
  const allAges = oldActive.map((r) => days(kst(r.matched_at), today));
  console.log(`    (참고) 구 행 active 전체 ${oldActive.length}건 경과일 중앙 ${med(allAges).toFixed(0)}일, 최대 ${Math.max(...allAges).toFixed(0)}일`);
  // 경험적 해소 속도: 구 규칙 KR 종료 행의 등록→종료 소요일
  const closed = ma.filter((r) => !marked(r.signal_details) && r.closed_at).map((r) => days(r.matched_at, r.closed_at!));
  const within = (d: number): string => `${((closed.filter((x) => x <= d).length / Math.max(closed.length, 1)) * 100).toFixed(0)}%`;
  console.log(`    구 규칙 KR 종료 행 ${closed.length}건의 등록→종료 소요일: 중앙 ${med(closed).toFixed(1)}, 75% ${q(closed, 0.75).toFixed(1)}, 90% ${q(closed, 0.9).toFixed(1)}, 최대 ${Math.max(...closed).toFixed(0)}일 (7일 내 ${within(7)}, 14일 내 ${within(14)}, 30일 내 ${within(30)})`);
  // 현재 active 행이 이미 종료 행의 최대 소요일을 넘긴 건수(오래된 행)
  const maxClosed = Math.max(...closed);
  console.log(`    active 중 이미 종료 행 최대 소요일(${maxClosed.toFixed(0)}일)을 넘긴 행: 전체 ${allAges.filter((a) => a > maxClosed).length}건 / 겹침 ${ages.filter((a) => a > maxClosed).length}건`);

  // 4. 모의 포지션(KR)에 연결된 구 행
  const pos = await fetchAllRows<{ id: string; portfolio_id: string; screening_result_id: string | null }>((from, to) =>
    supabaseAdmin.from("paper_positions").select("id, portfolio_id, screening_result_id").order("id").range(from, to));
  const linkedIds = new Set(pos.map((p) => p.screening_result_id).filter((x): x is string => !!x));
  const oldLinked = oldActive.filter((r) => linkedIds.has(r.id));
  const ovLinked = ovRows.filter((r) => linkedIds.has(r.id));
  console.log(`[4] 모의 포지션에 연결된 구 규칙 KR active 행 ${oldLinked.length}건: ${JSON.stringify(oldLinked.map((r) => r.stock_code))}; 그중 v3 겹침 종목에 속한 행 ${ovLinked.length}건: ${JSON.stringify(ovLinked.map((r) => r.stock_code))}`);
  console.log("완료");
}
main().catch((e) => { console.error(e); process.exit(1); });
