// 임시 운영 스크립트(2010~2014 수집): MODE=backup | verify | classify. 읽기 외 쓰기는 backup 모드의 Storage 복사뿐.
import { parquetReadObjects } from "hyparquet";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { downloadYearPrices, loadAllStockSeriesFromParquet, type StockDailyPriceRow } from "@/lib/stockDailyPricesStorage";
import { buildTradingDayIndex, computePostRatio, detectAdjustmentEvents } from "@/lib/priceAdjustment";

const MODE = process.env.YEARS ?? "";
const BUCKET = "stock-daily-prices";
const pct = (a: number, b: number) => (b === 0 ? "-" : ((a / b) * 100).toFixed(2) + "%");

async function backup() {
  for (const y of [2011, 2012, 2013, 2014]) {
    const { error } = await supabaseAdmin.storage.from(BUCKET).copy(`${y}.parquet`, `backup-pre2015/${y}.parquet`);
    console.log(y, error ? `복사 실패: ${error.message}` : "복사 완료");
  }
  const { data } = await supabaseAdmin.storage.from(BUCKET).list("backup-pre2015", { limit: 20 });
  let total = 0;
  for (const f of data ?? []) { const s = (f.metadata as { size?: number })?.size ?? 0; total += s; console.log("backup-pre2015/" + f.name, Math.round(s / 1024), "KB"); }
  console.log("백업 파일 수", (data ?? []).length, "합계", (total / 1048576).toFixed(2), "MB");
  const { data: orig } = await supabaseAdmin.storage.from(BUCKET).list("", { limit: 50 });
  for (const y of [2011, 2012, 2013, 2014]) { const f = (orig ?? []).find((e) => e.name === `${y}.parquet`); console.log("원본", y, Math.round(((f?.metadata as { size?: number })?.size ?? 0) / 1024), "KB"); }
}

async function readBackup(y: number): Promise<StockDailyPriceRow[]> {
  const { data, error } = await supabaseAdmin.storage.from(BUCKET).download(`backup-pre2015/${y}.parquet`);
  if (error) throw new Error(error.message);
  const rows = (await parquetReadObjects({ file: await data.arrayBuffer() })) as Record<string, number & string>[];
  return rows.map((r) => ({ stockCode: r.stock_code, tradeDate: r.trade_date, closePrice: r.close_price, marketCapEok: r.market_cap_eok, listedShares: r.listed_shares, openPrice: r.open_price ?? 0, volume: r.volume ?? 0, highPrice: r.high_price ?? 0, lowPrice: r.low_price ?? 0, tradingValue: r.trading_value ?? 0 }));
}

async function verify() {
  console.log("== (a) 연도별 통계/채움률 ==");
  const byYear = new Map<number, StockDailyPriceRow[]>();
  for (const y of [2010, 2011, 2012, 2013, 2014, 2015]) {
    const rows = await downloadYearPrices(y); byYear.set(y, rows);
    const n = rows.length;
    console.log(y, JSON.stringify({ rows: n, codes: new Set(rows.map((r) => r.stockCode)).size, days: new Set(rows.map((r) => r.tradeDate)).size,
      close: pct(rows.filter((r) => r.closePrice > 0).length, n), cap: pct(rows.filter((r) => r.marketCapEok > 0).length, n),
      shares: pct(rows.filter((r) => r.listedShares > 0).length, n), tradingValue: pct(rows.filter((r) => r.tradingValue > 0).length, n),
      open: pct(rows.filter((r) => r.openPrice > 0).length, n) }));
  }
  console.log("== (b) 구판(백업) 대비 겹치는 종목·날짜 종가 일치 ==");
  for (const y of [2011, 2012, 2013, 2014]) {
    const old = await readBackup(y);
    const cur = new Map((byYear.get(y) ?? []).map((r) => [r.stockCode + ":" + r.tradeDate, r]));
    let cmp = 0, same = 0, capSame = 0, shSame = 0, missing = 0; const bad: string[] = [];
    for (const o of old) {
      const c = cur.get(o.stockCode + ":" + o.tradeDate);
      if (!c) { missing++; continue; }
      cmp++;
      if (c.closePrice === o.closePrice) same++; else if (bad.length < 4) bad.push(`${o.stockCode} ${o.tradeDate} 구${o.closePrice} 신${c.closePrice}`);
      if (Math.abs(c.marketCapEok - o.marketCapEok) < 0.5) capSame++;
      if (c.listedShares === o.listedShares) shSame++;
    }
    console.log(y, JSON.stringify({ oldRows: old.length, compared: cmp, notInNew: missing, closeMatch: pct(same, cmp), capMatch: pct(capSame, cmp), sharesMatch: pct(shSame, cmp), bad }));
  }
  console.log("== (c) 상장폐지 종목 마지막 거래일 ==");
  const all = new Map<string, StockDailyPriceRow[]>();
  for (const y of [2010, 2011, 2012, 2013, 2014, 2015]) for (const r of byYear.get(y) ?? []) { const l = all.get(r.stockCode); if (l) l.push(r); else all.set(r.stockCode, [r]); }
  for (const [code, name] of [["012650", "쌍용건설"], ["004940", "외환은행"], ["005280", "부산은행"], ["005270", "대구은행"], ["001300", "제일모직"]]) {
    const rows = (all.get(code) ?? []).sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
    const last = rows.slice(-3).map((r) => `${r.tradeDate} 종가${r.closePrice} 거래량${r.volume} 시총${Math.round(r.marketCapEok)}억 주식수${r.listedShares}`);
    console.log(code, name, JSON.stringify({ rows: rows.length, first: rows[0]?.tradeDate, last }));
  }
  console.log("== (d) 2014-12-30 → 2015-01-02 연속성 ==");
  const a = new Map((byYear.get(2014) ?? []).filter((r) => r.tradeDate === "2014-12-30").map((r) => [r.stockCode, r]));
  const b = new Map((byYear.get(2015) ?? []).filter((r) => r.tradeDate === "2015-01-02").map((r) => [r.stockCode, r]));
  let both = 0, closeBrk = 0, capBrk = 0, shBrk = 0, onlyA = 0, onlyB = 0; const brk: string[] = [];
  for (const [c, ra] of a) { const rb = b.get(c); if (!rb) { onlyA++; continue; } both++;
    const cr = rb.closePrice / ra.closePrice, mr = rb.marketCapEok / ra.marketCapEok, sr = rb.listedShares / ra.listedShares;
    if (Math.abs(cr - 1) > 0.3) closeBrk++; if (mr < 0.7 || mr > 1.3) capBrk++; if (Math.abs(sr - 1) > 0.1) { shBrk++; if (brk.length < 5) brk.push(`${c} 주식수비${sr.toFixed(2)} 종가비${cr.toFixed(2)}`); } }
  for (const c of b.keys()) if (!a.has(c)) onlyB++;
  console.log(JSON.stringify({ day2014: a.size, day2015: b.size, both, onlyIn2014: onlyA, onlyIn2015: onlyB, closeJump30: closeBrk, capJump30: capBrk, sharesChange10pct: shBrk, brk }));
}

async function classify() {
  const series = await loadAllStockSeriesFromParquet(2010, 2015);
  const idx = buildTradingDayIndex(series);
  const events = new Map<string, { status: string; reason?: string }>();
  let applied = 0, low = 0;
  for (const rows of series.values()) for (const e of detectAdjustmentEvents(rows, "2010-01-01", idx)) { events.set(e.stockCode + ":" + e.eventDate, { status: e.status, reason: e.lowConfidenceReason ?? undefined }); if (e.status === "applied") applied++; else low++; }
  console.log("2010-01-01~2015 후보:", events.size, "자동적용", applied, "low_confidence", low);
  const cls: Record<string, Record<string, number>> = {};
  const bump = (g: string, k: string) => { (cls[g] ??= {})[k] = (cls[g][k] ?? 0) + 1; };
  for (const rows of series.values()) for (let i = 1; i < rows.length; i++) {
    const p = rows[i - 1], c = rows[i];
    if (!(p.closePrice > 0) || c.tradeDate >= "2015-06-15") continue;
    const dev = Math.abs(c.closePrice / p.closePrice - 1); if (dev <= 0.155) continue;
    const g = c.tradeDate >= "2015-01-01" ? "2015H1" : c.tradeDate.slice(0, 4);
    const ev = events.get(c.stockCode + ":" + c.tradeDate);
    const sh = p.listedShares > 0 ? c.listedShares / p.listedShares : 1;
    const sign = Math.sign(c.closePrice - p.closePrice);
    const streak = [[rows[i - 2], p], [c, rows[i + 1]]].some(([x, y]) => x && y && x.closePrice > 0 && Math.sign(y.closePrice - x.closePrice) === sign && Math.abs(y.closePrice / x.closePrice - 1) >= 0.2);
    let k: string;
    if (ev) k = ev.status === "applied" ? "이벤트 자동적용" : `이벤트 low_confidence(${ev.reason ?? "?"})`;
    else if (sh >= 1.4 || sh <= 1 / 1.4) k = "주식수 변화 동반(이벤트 아님)";
    else if (dev < 0.3) k = "15~30% 급등락(주식수 변화 없음)";
    else k = streak ? "30%+ 연속 급등락" : "30%+ 단일일(주식수 변화 없음)";
    bump(g, k);
  }
  for (const [g, m] of Object.entries(cls)) console.log(g, "합계", Object.values(m).reduce((a, b) => a + b, 0), JSON.stringify(m));
  const u = process.resourceUsage(); console.log("최대 RSS", (u.maxRSS / 1024).toFixed(0), "MB");
}

async function tvfill() {
  for (let y = 2015; y <= 2026; y++) {
    const rows = await downloadYearPrices(y); const n = rows.length;
    console.log(y, JSON.stringify({ rows: n, tradingValue: pct(rows.filter((r) => r.tradingValue > 0).length, n), codes: new Set(rows.map((r) => r.stockCode)).size,
      topCapMissingTV: pct(rows.filter((r) => r.marketCapEok >= 5000 && !(r.tradingValue > 0)).length, rows.filter((r) => r.marketCapEok >= 5000).length) }));
  }
}

async function size() {
  const { data } = await supabaseAdmin.storage.from(BUCKET).list("", { limit: 100 });
  let total = 0;
  for (const f of data ?? []) { const sz = (f.metadata as { size?: number })?.size ?? 0; total += sz; if (sz) console.log(f.name, (sz / 1048576).toFixed(2), "MB"); }
  console.log("stock-daily-prices 루트 합계", (total / 1048576).toFixed(2), "MB");
  const { data: bk } = await supabaseAdmin.storage.from(BUCKET).list("backup-pre2015", { limit: 20 });
  console.log("backup-pre2015 합계", ((bk ?? []).reduce((a, f) => a + ((f.metadata as { size?: number })?.size ?? 0), 0) / 1048576).toFixed(2), "MB");
}

async function sample() {
  const { data, error } = await supabaseAdmin.from("stock_price_adjustment_events").select("*").lt("event_date", "2015-01-01").order("event_date");
  if (error) throw new Error(error.message);
  const ev = data ?? [];
  console.log("테이블 event_date<2015-01-01 행:", ev.length, "applied", ev.filter((e) => e.status === "applied").length, "low_confidence", ev.filter((e) => e.status !== "applied").length);
  const reasons: Record<string, number> = {};
  for (const e of ev.filter((x) => x.status !== "applied")) reasons[e.low_confidence_reason ?? "?"] = (reasons[e.low_confidence_reason ?? "?"] ?? 0) + 1;
  console.log("low_confidence 사유:", JSON.stringify(reasons));
  const { count } = await supabaseAdmin.from("stock_price_adjustment_events").select("*", { count: "exact", head: true }).gte("event_date", "2015-01-01");
  console.log("테이블 event_date>=2015-01-01 행(기존, 변경 없어야 함):", count);
  const applied = ev.filter((e) => e.status === "applied");
  let seed = 20261007; const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const pick = [...applied]; for (let i = pick.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [pick[i], pick[j]] = [pick[j], pick[i]]; }
  const chosen = pick.slice(0, 15).sort((a, b) => a.event_date.localeCompare(b.event_date));
  const series = await loadAllStockSeriesFromParquet(2010, 2015);
  const names = new Map<string, Map<string, string>>();
  for (const d of new Set(chosen.map((e) => e.event_date as string))) {
    const m = new Map<string, string>(); const bas = d.replaceAll("-", "");
    for (const ep of ["stk_bydd_trd", "ksq_bydd_trd"]) { const r = await fetch(`https://data-dbg.krx.co.kr/svc/apis/sto/${ep}?basDd=${bas}`, { headers: { AUTH_KEY: process.env.KRX_API_KEY ?? "" } }); const b = (await r.json()) as { OutBlock_1?: { ISU_CD: string; ISU_NM: string }[] }; for (const x of b.OutBlock_1 ?? []) m.set(x.ISU_CD, x.ISU_NM); }
    names.set(d, m);
  }
  for (const e of chosen) {
    const rows = series.get(e.stock_code) ?? []; const i = rows.findIndex((r) => r.tradeDate === e.event_date);
    const p = rows[i - 1], c = rows[i]; const post = computePostRatio(rows, e.event_date, e.adjustment_factor);
    console.log(JSON.stringify({ 종목: `${names.get(e.event_date)?.get(e.stock_code) ?? "?"}(${e.stock_code})`, 날짜: e.event_date, 가격비: Number(e.price_ratio).toFixed(3), 주식수비: Number(e.shares_ratio).toFixed(3), 계수: Number(e.adjustment_factor).toFixed(4),
      주식수: `${p?.listedShares}→${c?.listedShares}`, 종가_원가: `${p?.closePrice}→${c?.closePrice}`, 종가_조정후: `${p ? Math.round(p.closePrice * e.adjustment_factor * 100) / 100 : "-"}→${c?.closePrice}`, 연속성비율: post === null ? "-" : post.toFixed(3) }));
  }
}

async function main() {
  if (MODE === "sample") return sample();
  if (MODE === "size") return size();
  if (MODE === "tvfill") return tvfill();
  if (MODE === "backup") return backup();
  if (MODE === "verify") return verify();
  if (MODE === "classify") return classify();
  throw new Error("MODE 필요");
}
main().catch((e) => { console.error(e); process.exit(1); });
