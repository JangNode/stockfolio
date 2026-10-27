/**
 * [임시 연구 — 병합 금지] 연구 A·B 공용 입력·지표 도구(실행 파일 아님). scripts/research-r-allcap.ts의 입력 적재·069500 기준선·지표 함수를 그대로 옮겼다.
 * 가격 Parquet(Actions 캐시)·적용된 조정 이벤트·069500 일별 가격은 읽기만 한다. DB·Storage 쓰기 0.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { parquetReadObjects } from "hyparquet";
import { getIndexPriceSeries } from "@/lib/betaPriceHistoryStorage";
import { INVESTOR_FLOW_STOCK_STORE_BUCKET } from "@/lib/investorFlowConfig";
import { MM_PARQUET_PATH } from "@/lib/marketMembershipConfig";
import { loadAllStockSeriesFromParquet } from "@/lib/stockDailyPricesStorage";
import { loadAppliedAdjustments } from "@/lib/stockPriceAdjustmentsStorage";
import { applyAdjustmentsInPlace } from "@/lib/priceAdjustment";
import { computeTrailingAvgTradingValue } from "@/lib/pitUniverse";
import { PIT_LIQUIDITY_LOOKBACK_DAYS, PIT_MIN_AVG_TRADING_VALUE_WON } from "@/lib/strategyBacktestSummaryConfig";
import { computeCumulativeAndMdd, computeCagrPct } from "@/lib/strategyBacktestSummary";
import { computeEffectiveBuyPrice, computeEffectiveSellPrice } from "@/lib/transactionCost";
import { ETF_SPIKE_MIN_ABS_RET, ETF_SPIKE_MAX_NET_ABS, ETF_SPIKE_KOSPI_EXEMPT_RATIO, ETF_TRADING_DAYS_PER_YEAR } from "@/lib/etfAllocationConfig";
import { SEASON_STOCK_CODE } from "@/lib/seasonalityConfig";
import { FLOW_TILT_ENDED_GRACE_DAYS } from "@/lib/foreignFlowTiltConfig";
import { SAT_SPAC_NAME_KEYWORDS, SAT_REIT_NAME_SUFFIX, SAT_REIT_KSIC_PREFIXES, SAT_REIT_EXPLICIT_CODES } from "@/lib/satelliteV1Config";
import { SLIPPAGE_PCT_PER_SIDE } from "@/lib/transactionCostConfig";
import { parquetCacheStats } from "@/lib/parquetDiskCache";
import { BENCH_AUX_FILE, BENCH_AUX_SHA256 } from "@/lib/benchmarkAuxConfig";

export interface S { code: string; dates: string[]; idx: Map<string, number>; close: Float64Array; raw: Float64Array; mcapRow: Float64Array; avgTvRow: Float64Array; vol: Float64Array; last: string }
export interface Win { from: string; to: string }
export type Ser = { dates: string[]; ret: number[] };
export const MS_DAY = 86_400_000;
export const f2 = (x: number): string => (Number.isFinite(x) ? x.toFixed(2) : "-");
export const ox = (b: boolean): string => (b ? "O" : "X");
export const dayDiff = (a: string, b: string): number => (Date.parse(b) - Date.parse(a)) / MS_DAY;
export const avg = (a: number[]): number => a.reduce((x, z) => x + z, 0) / Math.max(a.length, 1);
export const median = (a: number[]): number => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : NaN; };
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export const dbRead: Record<string, number> = {};
/** Storage에서 내려받은 바이트 합(보고용). */
export const xfer = { bytes: 0 };
/** 연구용 데이터 종료일(연구 LE~). 있으면 Parquet은 고정 스냅샷(PARQUET_CACHE_FROZEN=1)에서만 읽고, 이 날짜 뒤의 DB 행·조정 이벤트는 쓰지 않는다. */
export const SNAP_END: string | undefined = process.env.RESEARCH_DATA_END?.trim() || undefined;
/** 이번 실행의 Storage 내려받기 합계(바이트) = 월말 시장 목록 등 직접 내려받은 것 + 가격 Parquet 재다운로드(캐시 적중은 0). */
export const storageBytes = (): number => xfer.bytes + parquetCacheStats.downloadBytes;
export const storageLine = (): string => `Storage 내려받기 합계 ${(storageBytes() / 1048576).toFixed(2)} MiB(월말 시장 목록 ${(xfer.bytes / 1048576).toFixed(2)} + 가격 Parquet 다운로드 ${(parquetCacheStats.downloadBytes / 1048576).toFixed(2)}, 캐시 적중 ${parquetCacheStats.hits}건 ${(parquetCacheStats.hitBytes / 1048576).toFixed(2)} MiB는 전송 0)`;
export async function selectAll<T>(label: string, build: (f: number, t: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from, from + 999);
    if (error) throw new Error(`${label}: ${error.message}`);
    out.push(...(data ?? []));
    dbRead[label] = (dbRead[label] ?? 0) + (data?.length ?? 0);
    if ((data?.length ?? 0) < 1000) break;
  }
  return out;
}

export interface Harness {
  CAL: string[]; nCal: number; calIdx: Map<string, number>; dataEnd: string; monthEnds: string[];
  stocks: S[]; byCode: Map<string, S>; codes: string[];
  adjustments: Awaited<ReturnType<typeof loadAppliedAdjustments>>;
  endedBefore: string;
  bhP: Ser; bhRet: Map<string, number>;
  /** 069500 기준선을 DB(etf_daily_prices)만으로 만든 값. 보조 파일을 쓰지 않는 실행에서는 bhP와 같다(연구 LC의 신·구 기준선 비교용). */
  bhPDb: Ser;
  stockBuyMult: number; sellRate: (d: string) => number;
  st: (o: { dates: string[]; ret: number[]; costFrac?: number[]; turn?: { d: string; v: number }[]; nPos?: number[]; inv?: number[] }, win: Win) => { cagr: number; mdd: number; sharpe: number; vol: number; turnover: number; cost: number; avgN: number; avgInv: number };
  yearRet: (o: Ser, y: number) => number;
  worst12: (o: Ser, win: Win) => number;
  periodStat: (o: Ser, from: string, to: string) => string;
}

/** 고정 스냅샷의 매니페스트(snapshot.json)와 디스크 파일의 SHA-256을 대조해 같은 바이트인지 확인한다(PARQUET_CACHE_DIR의 연도 파일 전부). 다르면 던진다. */
export async function verifySnapshotManifest(): Promise<string> {
  const dir = process.env.PARQUET_CACHE_DIR?.trim();
  if (!dir) throw new Error("PARQUET_CACHE_DIR 없음");
  const man = JSON.parse(await fs.readFile(path.join(dir, "snapshot.json"), "utf8")) as { dataEnd: string; createdAt: string; files: { year: number; bytes: number; sha256: string }[] };
  for (const f of man.files) {
    const buf = await fs.readFile(path.join(dir, `${f.year}.parquet`));
    if (buf.byteLength !== f.bytes || createHash("sha256").update(buf).digest("hex") !== f.sha256) throw new Error(`스냅샷 ${f.year}.parquet이 매니페스트와 다릅니다`);
  }
  return `고정 스냅샷 매니페스트 대조 통과: 데이터 종료일 ${man.dataEnd}, 만든 시각 ${man.createdAt}, 파일 ${man.files.length}개 SHA-256 일치(합계 ${(man.files.reduce((a, f) => a + f.bytes, 0) / 1048576).toFixed(2)} MiB)`;
}

/** 입력 적재: 가격 Parquet 2010~, 적용된 조정 이벤트, 069500 가격(DB 읽기), 지표 함수. */
export async function loadHarness(): Promise<Harness> {
  const adjustments = await loadAppliedAdjustments();
  if (SNAP_END) for (const [code, list] of adjustments) { const kept = list.filter((e) => e.eventDate <= SNAP_END); if (kept.length) adjustments.set(code, kept); else adjustments.delete(code); }
  dbRead["stock_price_adjustment_events(applied)"] = [...adjustments.values()].reduce((a, l) => a + l.length, 0);
  const series = await loadAllStockSeriesFromParquet(2010, SNAP_END ? Number(SNAP_END.slice(0, 4)) : new Date().getUTCFullYear());
  if (SNAP_END) for (const [code, rows] of series) { const kept = rows.filter((r) => r.tradeDate <= SNAP_END); if (kept.length) series.set(code, kept); else series.delete(code); }
  const kospi = await getIndexPriceSeries("KOSPI", "2009-01-01", SNAP_END ?? new Date().toISOString().slice(0, 10));
  dbRead["beta_price_history(KOSPI)"] = kospi.length;
  interface Row0 { code: string; dates: string[]; close: Float64Array; raw: Float64Array; mcap: Float64Array; avgTv: Float64Array; vol: Float64Array }
  const rows0: Row0[] = [];
  const calSet = new Set<string>();
  for (const [code, rows] of series) {
    series.delete(code);
    if (!rows.length) continue;
    const adj = rows.map((r) => ({ ...r }));
    const al = adjustments.get(code);
    if (al) applyAdjustmentsInPlace(adj, al);
    for (const r of rows) if (r.tradeDate >= "2010-01-01") calSet.add(r.tradeDate);
    rows0.push({ code, dates: rows.map((r) => r.tradeDate), close: Float64Array.from(adj.map((r) => r.closePrice)), raw: Float64Array.from(rows.map((r) => r.closePrice)), mcap: Float64Array.from(rows.map((r) => r.marketCapEok)), vol: Float64Array.from(rows.map((r) => r.volume)), avgTv: computeTrailingAvgTradingValue(adj, PIT_LIQUIDITY_LOOKBACK_DAYS) });
  }
  const CAL = [...calSet].sort();
  const nCal = CAL.length, dataEnd = CAL[nCal - 1];
  if (SNAP_END && dataEnd !== SNAP_END) throw new Error(`고정 스냅샷의 마지막 거래일 ${dataEnd}이 데이터 종료일 ${SNAP_END}과 다릅니다`);
  const calIdx = new Map(CAL.map((d, i) => [d, i]));
  const monthEnds: string[] = [];
  for (let k = 0; k + 1 < nCal; k++) if (CAL[k].slice(0, 7) !== CAL[k + 1].slice(0, 7)) monthEnds.push(CAL[k]);
  const endedBefore = new Date(Date.parse(dataEnd) - FLOW_TILT_ENDED_GRACE_DAYS * MS_DAY).toISOString().slice(0, 10);
  const stocks: S[] = rows0
    .filter((r) => r.dates.some((d) => d >= "2010-01-01"))
    .map((r) => ({ code: r.code, dates: r.dates, idx: new Map(r.dates.map((d, i) => [d, i])), close: r.close, raw: r.raw, mcapRow: r.mcap, avgTvRow: r.avgTv, vol: r.vol, last: r.dates[r.dates.length - 1] }))
    .sort((a, b) => (a.code < b.code ? -1 : 1));
  rows0.length = 0;
  const byCode = new Map(stocks.map((s) => [s.code, s]));
  const codes = stocks.map((s) => s.code);
  console.log(`종목 ${codes.length}개, 거래일 ${nCal}일 ${CAL[0]}~${dataEnd}`);

  // ---- 069500 기준선(원주가, 가격 수익만) ----
  const etfRows = await selectAll<{ trade_date: string; adj_close: number | null; raw_close: number | null }>("etf_daily_prices(069500)", (f, t) => { const q = supabaseAdmin.from("etf_daily_prices").select("trade_date, adj_close, raw_close").eq("code", SEASON_STOCK_CODE); return (SNAP_END ? q.lte("trade_date", SNAP_END) : q).order("trade_date").range(f, t); });
  const kRetByDate = new Map<string, number>();
  for (let i = 1; i < kospi.length; i++) kRetByDate.set(kospi[i].tradeDate, kospi[i].closePrice / kospi[i - 1].closePrice - 1);
  const cut = (o: Ser): Ser => { const k = o.dates.filter((d) => d <= dataEnd).length; return { dates: o.dates.slice(0, k), ret: o.ret.slice(0, k) }; };
  const clean = (raw0: { date: string; px: number }[], label: string): Ser => {
    const e = raw0.map((x) => ({ ...x }));
    const r = raw0.map((x, i) => (i === 0 ? NaN : x.px / raw0[i - 1].px - 1));
    let nCh = 0;
    for (let t = 1; t + 1 < raw0.length; t++) {
      if (!(Math.abs(r[t]) > ETF_SPIKE_MIN_ABS_RET) || !(Math.sign(r[t + 1]) === -Math.sign(r[t])) || !(Math.abs((1 + r[t]) * (1 + r[t + 1]) - 1) < ETF_SPIKE_MAX_NET_ABS)) continue;
      const kr = kRetByDate.get(raw0[t].date);
      if (kr !== undefined && Math.sign(kr) === Math.sign(r[t]) && Math.abs(kr) >= ETF_SPIKE_KOSPI_EXEMPT_RATIO * Math.abs(r[t])) continue;
      e[t].px = Math.sqrt(raw0[t - 1].px * raw0[t + 1].px); nCh++;
    }
    console.log(`069500 ${label}: ${raw0.length}행 ${raw0[0]?.date}~${raw0[raw0.length - 1]?.date}, 정제로 바꾼 날 ${nCh}개`);
    return cut({ dates: e.slice(1).map((x) => x.date), ret: e.slice(1).map((x, i) => (x.px / e[i].px - 1) * 100) });
  };
  const bhPDb = clean(etfRows.filter((r) => r.raw_close !== null).map((r) => ({ date: r.trade_date, px: Number(r.raw_close) })), "원주가(raw_close, 가격)");
  // 연구 LC~: BENCH_AUX_069500=1이면 069500 원주가를 보조 파일(데이터 종료일까지 채움, SHA-256 대조)로 대체한다. 켜지 않으면 위 DB 값을 그대로 쓴다(기존 시험과 동일).
  let bhP = bhPDb;
  if (process.env.BENCH_AUX_069500 === "1") {
    const buf = await fs.readFile(BENCH_AUX_FILE);
    const sha = createHash("sha256").update(buf).digest("hex");
    if (sha !== BENCH_AUX_SHA256) throw new Error(`069500 보조 파일 SHA-256 불일치: ${sha} (기대 ${BENCH_AUX_SHA256})`);
    const aux = JSON.parse(buf.toString("utf8")) as { rows: [string, number, number][] };
    console.log(`069500 보조 파일 SHA-256 일치(${sha.slice(0, 12)}…), ${aux.rows.length}행 ${aux.rows[0][0]}~${aux.rows[aux.rows.length - 1][0]}, 그중 KRX로 채운 행 ${aux.rows.filter((r) => r[2] === 1).length}개`);
    bhP = clean(aux.rows.map((r) => ({ date: r[0], px: r[1] })), "원주가(보조 파일)");
  }
  const bhRet = new Map(bhP.dates.map((d, i) => [d, bhP.ret[i] / 100]));

  const stockBuyMult = computeEffectiveBuyPrice(1);
  const sellRate = (d: string): number => 1 - computeEffectiveSellPrice(1, d, "KR");

  function st(o: { dates: string[]; ret: number[]; costFrac?: number[]; turn?: { d: string; v: number }[]; nPos?: number[]; inv?: number[] }, win: Win) {
    const to = win.to > dataEnd ? dataEnd : win.to;
    const idx: number[] = [];
    for (let i = 0; i < o.dates.length; i++) if (o.dates[i] >= win.from && o.dates[i] <= win.to) idx.push(i);
    const r = idx.map((i) => o.ret[i]);
    const { totalReturnPct, mddPct } = computeCumulativeAndMdd(r);
    const m = r.reduce((a, x) => a + x, 0) / Math.max(r.length, 1);
    const sd = Math.sqrt(r.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(r.length - 1, 1));
    const yrs = Math.max(dayDiff(win.from, to) / 365.25, 1e-9);
    return {
      cagr: computeCagrPct(totalReturnPct, win.from, to), mdd: mddPct, sharpe: sd > 0 ? (m * ETF_TRADING_DAYS_PER_YEAR) / (sd * Math.sqrt(ETF_TRADING_DAYS_PER_YEAR)) : NaN, vol: sd * Math.sqrt(ETF_TRADING_DAYS_PER_YEAR),
      turnover: o.turn ? (o.turn.filter((x) => x.d >= win.from && x.d <= win.to).reduce((a, x) => a + x.v, 0) / yrs) * 100 : NaN,
      cost: o.costFrac ? idx.reduce((a, i) => a + o.costFrac![i], 0) * 100 : NaN,
      avgN: o.nPos ? idx.reduce((a, i) => a + o.nPos![i], 0) / Math.max(idx.length, 1) : NaN,
      avgInv: o.inv ? (idx.reduce((a, i) => a + o.inv![i], 0) / Math.max(idx.length, 1)) * 100 : NaN,
    };
  }
  const yearRet = (o: Ser, y: number): number => computeCumulativeAndMdd(o.ret.filter((_, i) => o.dates[i].startsWith(`${y}-`))).totalReturnPct;
  const winTo = (w: Win): string => (w.to > dataEnd ? dataEnd : w.to);
  const worst12 = (o: Ser, win: Win): number => {
    const val = new Map<string, number>();
    let V = 1;
    for (let i = 0; i < o.dates.length; i++) { V *= 1 + o.ret[i] / 100; val.set(o.dates[i], V); }
    const before = o.dates.filter((d) => d < win.from);
    const anchors = [before.length ? before[before.length - 1] : o.dates[0], ...monthEnds.filter((d) => d >= win.from && d <= winTo(win) && val.has(d))];
    let w = Infinity;
    for (let i = 0; i + 12 < anchors.length; i++) w = Math.min(w, (val.get(anchors[i + 12])! / val.get(anchors[i])! - 1) * 100);
    return w;
  };
  const periodStat = (o: Ser, from: string, to: string): string => {
    const r = o.ret.filter((_, i) => o.dates[i] >= from && o.dates[i] <= to);
    const x = computeCumulativeAndMdd(r);
    return `${f2(x.totalReturnPct)} / ${f2(x.mddPct)}`;
  };
  return { CAL, nCal, calIdx, dataEnd, monthEnds, stocks, byCode, codes, adjustments, endedBefore, bhP, bhPDb, bhRet, stockBuyMult, sellRate, st, yearRet, worst12, periodStat };
}

/** 이름(dart_corp_codes)·업종·ETF 겹침 → 제외 규칙(4c1557a: 우선주·ETF·스팩·리츠) 적용 후의 K200P(d) 구성. 월말 시장 목록은 Storage에서 읽는다(약 0.2 MiB). */
export async function loadK200P(h: Harness): Promise<{ kAt: (d: string) => S[]; nameOf: Map<string, string>; indOf: Map<string, string>; excluded: Set<string>; membAt: (d: string) => Map<string, string> | undefined }> {
  const nameOf = new Map<string, string>(), indOf = new Map<string, string>(), etfSet = new Set<string>();
  for (let i = 0; i < h.codes.length; i += 200) {
    const chunk = h.codes.slice(i, i + 200);
    for (const r of await selectAll<{ isu_cd: string }>("etf_krx_daily(유니버스 코드와 겹치는 행)", (f, t) => supabaseAdmin.from("etf_krx_daily").select("isu_cd").in("isu_cd", chunk).order("isu_cd").order("bas_dd").range(f, t))) etfSet.add(r.isu_cd);
    for (const r of await selectAll<{ code: string }>("etf_daily_prices(유니버스 코드와 겹치는 행)", (f, t) => supabaseAdmin.from("etf_daily_prices").select("code").in("code", chunk).order("code").order("trade_date").range(f, t))) etfSet.add(r.code);
    for (const r of await selectAll<{ corp_code: string; corp_name: string; stock_code: string }>("dart_corp_codes(유니버스 코드)", (f, t) => supabaseAdmin.from("dart_corp_codes").select("corp_code, corp_name, stock_code").in("stock_code", chunk).order("corp_code").range(f, t))) nameOf.set(r.stock_code, r.corp_name);
    for (const r of await selectAll<{ stock_code: string; induty_code: string | null }>("stock_industry_classification(유니버스 코드)", (f, t) => supabaseAdmin.from("stock_industry_classification").select("stock_code, induty_code").in("stock_code", chunk).order("stock_code").range(f, t))) if (r.induty_code) indOf.set(r.stock_code, r.induty_code);
  }
  const excluded = new Set<string>();
  for (const c of h.codes) {
    const n = nameOf.get(c), ic = indOf.get(c);
    if (c[c.length - 1] !== "0" || etfSet.has(c)) excluded.add(c);
    if (n !== undefined && (SAT_SPAC_NAME_KEYWORDS.some((k) => n.includes(k)) || n.trim().endsWith(SAT_REIT_NAME_SUFFIX))) excluded.add(c);
    if (ic && SAT_REIT_KSIC_PREFIXES.some((p) => ic.startsWith(p))) excluded.add(c);
    if ((SAT_REIT_EXPLICIT_CODES as readonly string[]).includes(c)) excluded.add(c);
  }
  console.log(`제외 규칙(4c1557a) 해당 ${excluded.size}개 (ETF 겹침 ${etfSet.size}개)`);
  const mmDl = await supabaseAdmin.storage.from(INVESTOR_FLOW_STOCK_STORE_BUCKET).download(MM_PARQUET_PATH);
  if (mmDl.error || !mmDl.data) throw new Error(`${MM_PARQUET_PATH} 없음`);
  const mmRows = (await parquetReadObjects({ file: await mmDl.data.arrayBuffer() })) as { trade_date: string; stock_code: string; market: string }[];
  const memb = new Map<string, Map<string, string>>();
  for (const r of mmRows) { let m = memb.get(r.trade_date); if (!m) { m = new Map(); memb.set(r.trade_date, m); } m.set(r.stock_code, r.market); }
  const mmDates = [...memb.keys()].sort();
  xfer.bytes += (mmDl.data as Blob).size;
  const mmFor = (d: string): string | undefined => { let lo = 0, hi = mmDates.length - 1, k = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (mmDates[m] <= d) { k = m; lo = m + 1; } else hi = m - 1; } return k >= 0 ? mmDates[k] : undefined; };
  const kwCache = new Map<string, S[]>();
  const kAt = (d: string): S[] => {
    let v = kwCache.get(d);
    if (!v) {
      const md = mmFor(d), m = md !== undefined ? memb.get(md) : undefined;
      const e: { s: S; mcap: number }[] = [];
      if (m) for (const s of h.stocks) {
        const i = s.idx.get(d);
        if (i !== undefined && s.avgTvRow[i] >= PIT_MIN_AVG_TRADING_VALUE_WON && !excluded.has(s.code) && m.get(s.code) === "KOSPI") e.push({ s, mcap: s.mcapRow[i] });
      }
      e.sort((a, b) => b.mcap - a.mcap || (a.s.code < b.s.code ? -1 : 1));
      v = e.slice(0, 200).map((x) => x.s);
      kwCache.set(d, v);
    }
    return v;
  };
  return { kAt, nameOf, indOf, excluded, membAt: (d) => { const md = mmFor(d); return md !== undefined ? memb.get(md) : undefined; } };
}
export { SLIPPAGE_PCT_PER_SIDE };
