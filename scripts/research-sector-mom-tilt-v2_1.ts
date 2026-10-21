/**
 * [임시 연구 — 병합 금지, 읽기 전용, 외부 요청 0건] 업종 모멘텀 틸트 v2.1(바탕 KOSPI 시총 상위 200) 백테스트(누적 시도 142).
 * 사전 등록: research/sector-mom-tilt-prereg.md (6c49375) + research/sector-mom-tilt-v2_1-prereg.md (e1ab2e6). 제외 규칙은 research/satellite-v1_2-prereg.md(4c1557a), 엔진은 그 이전 사전등록과 같다.
 * 숫자와 표, O/X만 출력한다.
 */
import { getIndexPriceSeries } from "@/lib/betaPriceHistoryStorage";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadAllStockSeriesFromParquet } from "@/lib/stockDailyPricesStorage";
import { loadAppliedAdjustments } from "@/lib/stockPriceAdjustmentsStorage";
import { applyAdjustmentsInPlace } from "@/lib/priceAdjustment";
import { computeTrailingAvgTradingValue } from "@/lib/pitUniverse";
import { PIT_LIQUIDITY_LOOKBACK_DAYS, PIT_MIN_AVG_TRADING_VALUE_WON } from "@/lib/strategyBacktestSummaryConfig";
import { computeCumulativeAndMdd, computeCagrPct } from "@/lib/strategyBacktestSummary";
import { computeIndexDailyReturnsPct } from "@/lib/benchmarkSummary";
import { computeEffectiveBuyPrice, computeEffectiveSellPrice } from "@/lib/transactionCost";
import { ETF_SPIKE_MIN_ABS_RET, ETF_SPIKE_MAX_NET_ABS, ETF_SPIKE_KOSPI_EXEMPT_RATIO, ETF_TRADING_DAYS_PER_YEAR } from "@/lib/etfAllocationConfig";
import { SEASON_STOCK_CODE } from "@/lib/seasonalityConfig";
import { SCAN_CAP_EOK, SCAN_POOL_SIZE } from "@/lib/signalScanConfig";
import { FLOW_TILT_ENDED_GRACE_DAYS } from "@/lib/foreignFlowTiltConfig";
import { LV_CONFIRM, LV_HOLDOUT_FROM } from "@/lib/smallcapLowvolConfig";
import { SAT_SPAC_NAME_KEYWORDS, SAT_REIT_NAME_SUFFIX, SAT_REIT_KSIC_PREFIXES, SAT_REIT_EXPLICIT_CODES, SAT_MDD_EPS, SAT_SECTOR_UNCLASSIFIED, SAT_KSIC_DIVISION_NAMES } from "@/lib/satelliteV1Config";
import {
  SMT_FIRST_SIGNAL_MONTH, SMT_LEARN, SMT_LOOKBACK_MONTHS, SMT_SKIP_MONTHS, SMT_TOP_K, SMT_MULT_TOP, SMT_MULT_BOTTOM, SMT_MIN_SECTOR_STOCKS,
  SMT_G1_MARGIN_PP, SMT_G3_MDD_MARGIN_PP, SMT_G4_MAX_DELAY_DROP_PP, SMT_R1_LOOKBACKS, SMT_R1_TOP_KS, SMT_R1_MULTS, SMT_R3_DRAWS, SMT_R3_SEED, SMT_MONTHS_PER_YEAR, SMT21_K_SIZE, SMT21_STAGE0_MAX_UNKNOWN_PCT,
} from "@/lib/sectorMomTiltConfig";

const T0 = Date.now();
const MS_DAY = 86_400_000;
const f2 = (x: number): string => (Number.isFinite(x) ? x.toFixed(2) : "-");
const ox = (b: boolean): string => (b ? "O" : "X");
const dayDiff = (a: string, b: string): number => (Date.parse(b) - Date.parse(a)) / MS_DAY;
const dbRead: Record<string, number> = {};
async function selectAll<T>(label: string, build: (f: number, t: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
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
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

interface S { code: string; dates: string[]; idx: Map<string, number>; close: Float64Array; mcapRow: Float64Array; avgTvRow: Float64Array; last: string }
interface Target { w: Map<string, number>; n: number }
interface Out { dates: string[]; ret: number[]; costFrac: number[]; turn: { d: string; v: number }[]; nPos: number[]; liq: string[] }
interface Win { from: string; to: string }
interface Cfg { L: number; K: number; mTop: number; mBot: number }

async function main(): Promise<void> {
  console.log(`업종 모멘텀 틸트 v2.1 시작(읽기 전용): ${new Date().toISOString()} (사전등록 e1ab2e6 이후)`);
  const adjustments = await loadAppliedAdjustments();
  dbRead["stock_price_adjustment_events(applied)"] = [...adjustments.values()].reduce((a, l) => a + l.length, 0);
  const series = await loadAllStockSeriesFromParquet(2010, new Date().getUTCFullYear());
  const kospi = await getIndexPriceSeries("KOSPI", "2009-01-01", new Date().toISOString().slice(0, 10));
  dbRead["beta_price_history(KOSPI)"] = kospi.length;

  interface Row0 { code: string; dates: string[]; close: Float64Array; mcap: Float64Array; avgTv: Float64Array }
  const rows0: Row0[] = [];
  const calSet = new Set<string>();
  for (const [code, rows] of series) {
    series.delete(code);
    if (!rows.length) continue;
    const adj = rows.map((r) => ({ ...r }));
    const al = adjustments.get(code);
    if (al) applyAdjustmentsInPlace(adj, al);
    for (const r of rows) if (r.tradeDate >= "2010-01-01") calSet.add(r.tradeDate);
    rows0.push({ code, dates: rows.map((r) => r.tradeDate), close: Float64Array.from(adj.map((r) => r.closePrice)), mcap: Float64Array.from(rows.map((r) => r.marketCapEok)), avgTv: computeTrailingAvgTradingValue(adj, PIT_LIQUIDITY_LOOKBACK_DAYS) });
  }
  const CAL = [...calSet].sort();
  const nCal = CAL.length, dataEnd = CAL[nCal - 1];
  const calIdx = new Map(CAL.map((d, i) => [d, i]));
  const monthEnds: string[] = [];
  for (let k = 0; k + 1 < nCal; k++) if (CAL[k].slice(0, 7) !== CAL[k + 1].slice(0, 7)) monthEnds.push(CAL[k]);
  const endedBefore = new Date(Date.parse(dataEnd) - FLOW_TILT_ENDED_GRACE_DAYS * MS_DAY).toISOString().slice(0, 10);
  const firstSignal = monthEnds.find((d) => d.slice(0, 7) === SMT_FIRST_SIGNAL_MONTH)!;
  const sigs = monthEnds.filter((d) => d >= firstSignal);
  const meIdx = new Map(monthEnds.map((d, i) => [d, i]));
  const firstExec = CAL[calIdx.get(firstSignal)! + 1];
  console.log(`종목 ${rows0.length}개, 거래일 ${nCal}일 ${CAL[0]}~${dataEnd}, 월간 신호 ${sigs.length}개(첫 신호 ${firstSignal}, 첫 체결 ${firstExec}, 마지막 신호 ${sigs[sigs.length - 1]})`);

  const isElig = (r: { mcap: Float64Array; avgTv: Float64Array }, i: number): boolean => i >= 1 && r.mcap[i - 1] >= SCAN_CAP_EOK && r.avgTv[i] >= PIT_MIN_AVG_TRADING_VALUE_WON;
  const stocks: S[] = rows0
    .filter((r) => r.dates.some((d) => d >= "2010-01-01"))
    .map((r) => ({ code: r.code, dates: r.dates, idx: new Map(r.dates.map((d, i) => [d, i])), close: r.close, mcapRow: r.mcap, avgTvRow: r.avgTv, last: r.dates[r.dates.length - 1] }))
    .sort((a, b) => (a.code < b.code ? -1 : 1));
  rows0.length = 0;
  const byCode = new Map(stocks.map((s) => [s.code, s]));
  const codes = stocks.map((s) => s.code);
  console.log(`2010년 이후 가격 행이 있는 종목 ${codes.length}개`);

  // ---- 이름·업종·제외 규칙(4c1557a) ----
  const nameOf = new Map<string, string>(), indOf = new Map<string, string>(), etfSet = new Set<string>();
  for (let i = 0; i < codes.length; i += 200) {
    const chunk = codes.slice(i, i + 200);
    for (const r of await selectAll<{ isu_cd: string }>("etf_krx_daily(유니버스 코드와 겹치는 행)", (f, t) => supabaseAdmin.from("etf_krx_daily").select("isu_cd").in("isu_cd", chunk).order("isu_cd").order("bas_dd").range(f, t))) etfSet.add(r.isu_cd);
    for (const r of await selectAll<{ code: string }>("etf_daily_prices(유니버스 코드와 겹치는 행)", (f, t) => supabaseAdmin.from("etf_daily_prices").select("code").in("code", chunk).order("code").order("trade_date").range(f, t))) etfSet.add(r.code);
    for (const r of await selectAll<{ corp_code: string; corp_name: string; stock_code: string }>("dart_corp_codes(유니버스 코드)", (f, t) => supabaseAdmin.from("dart_corp_codes").select("corp_code, corp_name, stock_code").in("stock_code", chunk).order("corp_code").range(f, t))) nameOf.set(r.stock_code, r.corp_name);
    for (const r of await selectAll<{ stock_code: string; induty_code: string | null }>("stock_industry_classification(유니버스 코드)", (f, t) => supabaseAdmin.from("stock_industry_classification").select("stock_code, induty_code").in("stock_code", chunk).order("stock_code").range(f, t))) if (r.induty_code) indOf.set(r.stock_code, r.induty_code);
  }
  const excluded = new Set<string>();
  for (const c of codes) {
    const n = nameOf.get(c), ic = indOf.get(c);
    if (c[c.length - 1] !== "0" || etfSet.has(c)) excluded.add(c);
    if (n !== undefined && (SAT_SPAC_NAME_KEYWORDS.some((k) => n.includes(k)) || n.trim().endsWith(SAT_REIT_NAME_SUFFIX))) excluded.add(c);
    if (ic && SAT_REIT_KSIC_PREFIXES.some((p) => ic.startsWith(p))) excluded.add(c);
    if ((SAT_REIT_EXPLICIT_CODES as readonly string[]).includes(c)) excluded.add(c);
  }
  console.log(`제외 규칙(4c1557a) 해당 ${excluded.size}개 (ETF 겹침 ${etfSet.size}개) | 업종 분류 보유 ${codes.filter((c) => indOf.has(c)).length}/${codes.length}개`);
  const sectorOf = (c: string): string => indOf.get(c)?.slice(0, 2) ?? SAT_SECTOR_UNCLASSIFIED;
  const secLabel = (g: string): string => (g === SAT_SECTOR_UNCLASSIFIED ? g : `${g} ${SAT_KSIC_DIVISION_NAMES[g] ?? "?"}`);

  // ---- 유니버스 ----
  const uCache = new Map<string, S[]>();
  const pAt = (d: string): S[] => {
    let v = uCache.get(d);
    if (!v) {
      const e: { s: S; mcap: number }[] = [];
      for (const s of stocks) { const i = s.idx.get(d); if (i !== undefined && isElig({ mcap: s.mcapRow, avgTv: s.avgTvRow }, i)) e.push({ s, mcap: s.mcapRow[i] }); }
      v = e.sort((a, b) => b.mcap - a.mcap || (a.s.code < b.s.code ? -1 : 1)).slice(0, SCAN_POOL_SIZE).map((x) => x.s).filter((s) => !excluded.has(s.code));
      uCache.set(d, v);
    }
    return v;
  };
  const mcapAt = (s: S, d: string): number => s.mcapRow[s.idx.get(d)!];

  // ---- 0단계: 시장 구분 ----
  const betaRows = await selectAll<{ stock_code: string; market: string; computed_at: string }>("stock_beta", (f, t) => supabaseAdmin.from("stock_beta").select("stock_code, market, computed_at").order("stock_code").range(f, t));
  const mktOf = new Map(betaRows.map((r) => [r.stock_code, r.market]));
  const comp = betaRows.map((r) => r.computed_at).sort();
  console.log(`\n=== 0단계: 시장 구분 ===\n출처: stock_beta.market(현재 값 하나, 시점별 이력 없음, 상장폐지 종목 없음). 가격 Parquet에는 시장 컬럼 없음. 이전 상장 종목 수: 시점별 이력이 없어 셀 수 없음.`);
  console.log(`stock_beta ${betaRows.length}행 (KOSPI ${betaRows.filter((r) => r.market === "KOSPI").length}, KOSDAQ ${betaRows.filter((r) => r.market === "KOSDAQ").length}), computed_at ${comp[0] ?? "-"}~${comp[comp.length - 1] ?? "-"} | 가격 Parquet 종목 중 시장 값 있음 ${codes.filter((c) => mktOf.has(c)).length}/${codes.length}`);
  const liquidAt = (d: string): { s: S; mcap: number }[] => {
    const e: { s: S; mcap: number }[] = [];
    for (const s of stocks) { const i = s.idx.get(d); if (i !== undefined && s.avgTvRow[i] >= PIT_MIN_AVG_TRADING_VALUE_WON && !excluded.has(s.code)) e.push({ s, mcap: s.mcapRow[i] }); }
    return e.sort((a, b) => b.mcap - a.mcap || (a.s.code < b.s.code ? -1 : 1));
  };
  const kCache = new Map<string, S[]>();
  const kAt = (d: string): S[] => {
    let v = kCache.get(d);
    if (!v) { v = liquidAt(d).filter((x) => mktOf.get(x.s.code) === "KOSPI").slice(0, SMT21_K_SIZE).map((x) => x.s); kCache.set(d, v); }
    return v;
  };
  console.log("| 연도 | 신호일 수 | 후보 C(d) 평균 종목 수 | 시장 미상 시총 비율 % (평균) | (최대) | 미상 종목 수 평균 | K200P 평균 종목 수 | K200P 업종 분류 보유 % (시총, 평균) |\n|---|---|---|---|---|---|---|---|");
  let stage0Ok = true;
  for (let y = Number(firstSignal.slice(0, 4)); y <= Number(dataEnd.slice(0, 4)); y++) {
    const ds = sigs.filter((d) => d.startsWith(`${y}-`));
    const share: number[] = [], nC: number[] = [], nU: number[] = [], nK: number[] = [], ind: number[] = [];
    for (const d of ds) {
      const L = liquidAt(d), K = kAt(d);
      const cut200 = K.length ? mcapAt(K[K.length - 1], d) : Infinity;
      const C = L.filter((x) => x.mcap >= cut200);
      const tot = C.reduce((a, x) => a + x.mcap, 0), unk = C.filter((x) => !mktOf.has(x.s.code));
      share.push((unk.reduce((a, x) => a + x.mcap, 0) / tot) * 100); nC.push(C.length); nU.push(unk.length); nK.push(K.length);
      const kt = K.reduce((a, s) => a + mcapAt(s, d), 0);
      ind.push((K.filter((s) => indOf.has(s.code)).reduce((a, s) => a + mcapAt(s, d), 0) / kt) * 100);
    }
    const avg = (a: number[]): number => a.reduce((x, z) => x + z, 0) / a.length;
    if (!(avg(share) <= SMT21_STAGE0_MAX_UNKNOWN_PCT)) stage0Ok = false;
    console.log(`| ${y} | ${ds.length} | ${f2(avg(nC))} | ${f2(avg(share))} | ${f2(Math.max(...share))} | ${f2(avg(nU))} | ${f2(avg(nK))} | ${f2(avg(ind))} |`);
  }
  console.log(`0단계 게이트: ${stage0Ok ? `모든 연도 시장 미상 시총 비율 ≤ ${SMT21_STAGE0_MAX_UNKNOWN_PCT}% → 계속(시장 값은 현재 값 하나)` : `시장 미상 시총 비율 ${SMT21_STAGE0_MAX_UNKNOWN_PCT}% 초과 연도 있음 → 이후 계산하지 않음`}`);
  if (!stage0Ok) return finish();

  // ---- 업종 모멘텀·목표 비중 ----
  const pxLe = (s: S, d: string): { px: number; mcap: number } | null => {
    let lo = 0, hi = s.dates.length - 1, k = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (s.dates[m] <= d) { k = m; lo = m + 1; } else hi = m - 1; }
    return k >= 0 && s.close[k] > 0 ? { px: s.close[k], mcap: s.mcapRow[k] } : null;
  };
  const momCache = new Map<string, Map<string, { n: number; mom: number }>>();
  /** 유효 업종(종목 2개 이상)별 모멘텀. 시작 월말이 없으면 빈 맵(전부 중립). */
  const sectorMom = (d: string, L: number): Map<string, { n: number; mom: number }> => {
    const key = `${d}|${L}`;
    let v = momCache.get(key);
    if (v) return v;
    v = new Map();
    const m = meIdx.get(d)!, sI = m - L, eI = m - SMT_SKIP_MONTHS;
    if (sI >= 0) {
      const S0 = monthEnds[sI], E0 = monthEnds[eI];
      const agg = new Map<string, { w: number; wr: number; n: number }>();
      for (const s of kAt(d)) {
        const g = sectorOf(s.code);
        if (g === SAT_SECTOR_UNCLASSIFIED) continue;
        const a = pxLe(s, S0), b = pxLe(s, E0);
        if (!a || !b || !(a.mcap > 0)) continue;
        const e = agg.get(g) ?? { w: 0, wr: 0, n: 0 };
        e.w += a.mcap; e.wr += a.mcap * (b.px / a.px - 1); e.n++;
        agg.set(g, e);
      }
      for (const [g, e] of agg) if (e.n >= SMT_MIN_SECTOR_STOCKS) v.set(g, { n: e.n, mom: e.wr / e.w });
    }
    momCache.set(key, v);
    return v;
  };
  const rankedSectors = (d: string, L: number): string[] => [...sectorMom(d, L)].sort((a, b) => b[1].mom - a[1].mom || (a[0] < b[0] ? -1 : 1)).map((x) => x[0]);
  const multMap = (order: string[], cfg: Cfg): Map<string, number> => {
    const K = Math.min(cfg.K, Math.floor(order.length / 2));
    const mm = new Map<string, number>();
    order.forEach((g, i) => { if (i < K) mm.set(g, cfg.mTop); else if (i >= order.length - K) mm.set(g, cfg.mBot); });
    return mm;
  };
  const weights = (d: string, mm: Map<string, number> | null, univ: (d: string) => S[]): Target => {
    const w = new Map<string, number>();
    let tot = 0;
    for (const s of univ(d)) { const x = mcapAt(s, d) * (mm?.get(sectorOf(s.code)) ?? 1); if (x > 0) { w.set(s.code, x); tot += x; } }
    for (const [k, x] of w) w.set(k, x / tot);
    return { w, n: w.size };
  };
  const BASE: Cfg = { L: SMT_LOOKBACK_MONTHS, K: SMT_TOP_K, mTop: SMT_MULT_TOP, mBot: SMT_MULT_BOTTOM };
  const targetsOf = (cfg: Cfg): Target[] => sigs.map((d) => weights(d, multMap(rankedSectors(d, cfg.L), cfg), kAt));

  const buyRate = computeEffectiveBuyPrice(1) - 1;
  const sellRate = (d: string): number => 1 - computeEffectiveSellPrice(1, d, "KR");
  function run(targets: Target[], delay: boolean): Out {
    const execAt = new Map<string, Target>();
    sigs.forEach((d, k) => { const j = calIdx.get(d)! + 1 + (delay ? 1 : 0); if (j < nCal) execAt.set(CAL[j], targets[k]); });
    let cash = 1, prevV = 1;
    const pos = new Map<string, { val: number; last: number }>();
    const out: Out = { dates: [], ret: [], costFrac: [], turn: [], nPos: [], liq: [] };
    for (let c = calIdx.get(firstExec)!; c < nCal; c++) {
      const d = CAL[c];
      const sr = sellRate(d);
      let costF = 0;
      for (const [code, p] of pos) {
        const sk = byCode.get(code)!;
        const i = sk.idx.get(d);
        if (i !== undefined) { p.val = (p.val * sk.close[i]) / p.last; p.last = sk.close[i]; }
        else if (sk.last < d && sk.last < endedBefore) { costF += (p.val * sr) / prevV; cash += p.val * (1 - sr); pos.delete(code); out.liq.push(d); }
      }
      const now = execAt.get(d);
      if (now) {
        let V = cash;
        for (const p of pos.values()) V += p.val;
        const tg = new Map<string, number>();
        for (const [code, w] of now.w) if (byCode.get(code)!.idx.has(d) && w > 0) tg.set(code, w);
        let buyN = 0, sellN = 0;
        for (const [code, p] of pos) if (!tg.has(code)) sellN += p.val;
        for (const [code, w] of tg) { const diff = w * V - (pos.get(code)?.val ?? 0); if (diff > 0) buyN += diff; else sellN += -diff; }
        const C = buyN * buyRate + sellN * sr, scale = V > 0 ? (V - C) / V : 1;
        pos.clear();
        let inv = 0;
        for (const [code, w] of tg) { const sk = byCode.get(code)!; const val = w * V * scale; pos.set(code, { val, last: sk.close[sk.idx.get(d)!] }); inv += val; }
        cash = V - C - inv;
        costF += V > 0 ? C / V : 0;
        if (buyN + sellN > 0) out.turn.push({ d, v: V > 0 ? (buyN + sellN) / 2 / V : 0 });
      }
      let V = cash;
      for (const p of pos.values()) V += p.val;
      out.dates.push(d); out.ret.push((V / prevV - 1) * 100); out.costFrac.push(costF); out.nPos.push(pos.size);
      prevV = V;
    }
    return out;
  }
  function st(o: { dates: string[]; ret: number[]; costFrac?: number[]; turn?: { d: string; v: number }[]; nPos?: number[] }, win: Win) {
    const to = win.to > dataEnd ? dataEnd : win.to;
    const idx: number[] = [];
    for (let i = 0; i < o.dates.length; i++) if (o.dates[i] >= win.from && o.dates[i] <= win.to && o.dates[i] > firstExec) idx.push(i);
    const r = idx.map((i) => o.ret[i]);
    const { totalReturnPct, mddPct } = computeCumulativeAndMdd(r);
    const m = r.reduce((a, x) => a + x, 0) / Math.max(r.length, 1);
    const sd = Math.sqrt(r.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(r.length - 1, 1));
    const yrs = Math.max(dayDiff(win.from, to) / 365.25, 1e-9);
    return {
      cagr: computeCagrPct(totalReturnPct, win.from, to), mdd: mddPct, sharpe: sd > 0 ? (m * ETF_TRADING_DAYS_PER_YEAR) / (sd * Math.sqrt(ETF_TRADING_DAYS_PER_YEAR)) : NaN, vol: sd * Math.sqrt(ETF_TRADING_DAYS_PER_YEAR),
      turnover: o.turn ? (o.turn.filter((x) => x.d >= win.from && x.d <= win.to && x.d > firstExec).reduce((a, x) => a + x.v, 0) / (yrs * SMT_MONTHS_PER_YEAR)) * 100 : NaN,
      cost: o.costFrac ? idx.reduce((a, i) => a + o.costFrac![i], 0) * 100 : NaN,
      avgN: o.nPos ? idx.reduce((a, i) => a + o.nPos![i], 0) / Math.max(idx.length, 1) : NaN,
    };
  }
  const yearRet = (o: { dates: string[]; ret: number[] }, y: number): number => computeCumulativeAndMdd(o.ret.filter((_, i) => o.dates[i].startsWith(`${y}-`) && o.dates[i] > firstExec)).totalReturnPct;

  // ---- B&H(가격·총수익), KOSPI ----
  const etfRows = await selectAll<{ trade_date: string; adj_close: number | null; raw_close: number | null }>("etf_daily_prices(069500)", (f, t) => supabaseAdmin.from("etf_daily_prices").select("trade_date, adj_close, raw_close").eq("code", SEASON_STOCK_CODE).order("trade_date").range(f, t));
  const kRetByDate = new Map<string, number>();
  for (let i = 1; i < kospi.length; i++) kRetByDate.set(kospi[i].tradeDate, kospi[i].closePrice / kospi[i - 1].closePrice - 1);
  const cut = (o: { dates: string[]; ret: number[] }): { dates: string[]; ret: number[] } => { const k = o.dates.filter((d) => d <= dataEnd).length; return { dates: o.dates.slice(0, k), ret: o.ret.slice(0, k) }; };
  const clean = (raw0: { date: string; px: number }[], label: string): { dates: string[]; ret: number[] } => {
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
  const bhP = clean(etfRows.filter((r) => r.raw_close !== null).map((r) => ({ date: r.trade_date, px: Number(r.raw_close) })), "원주가(raw_close, 가격)");
  const bhT = clean(etfRows.filter((r) => r.adj_close !== null).map((r) => ({ date: r.trade_date, px: Number(r.adj_close) })), "수정주가(adj_close, 총수익)");
  const kp = kospi.filter((x) => x.tradeDate >= "2009-12-01");
  const kos = cut({ dates: kp.slice(1).map((x) => x.tradeDate), ret: computeIndexDailyReturnsPct(kp as never) });

  // ---- 실행 ----
  const tV = targetsOf(BASE), tK = sigs.map((d) => weights(d, null, kAt)), tPool = sigs.map((d) => weights(d, null, pAt));
  const V = run(tV, false), VD = run(tV, true), KP = run(tK, false), KPD = run(tK, true), POOL = run(tPool, false), POOLD = run(tPool, true);
  const LEARN: Win = { ...SMT_LEARN }, CONFIRM: Win = { ...LV_CONFIRM }, HOLD: Win = { from: LV_HOLDOUT_FROM, to: "9999-12-31" }, FULL: Win = { from: SMT_LEARN.from, to: "9999-12-31" };
  const WINS: [string, Win][] = [["학습", LEARN], ["확인", CONFIRM], ["2022~", HOLD], ["전 기간", FULL]];
  for (const [name, win] of WINS) {
    const s = st(V, win), sd = st(VD, win), k = st(KP, win), kd = st(KPD, win), p = st(POOL, win), pd = st(POOLD, win), b = st(bhP, win), bt = st(bhT, win), ko = st(kos, win);
    const drop = s.cagr - sd.cagr;
    const g = [s.cagr >= k.cagr + SMT_G1_MARGIN_PP, s.cagr > b.cagr, s.mdd <= k.mdd + SMT_G3_MDD_MARGIN_PP + SAT_MDD_EPS, drop <= SMT_G4_MAX_DELAY_DROP_PP];
    console.log(`\n=== ${name} ${win.from}~${win.to > dataEnd ? dataEnd : win.to} ===\n| 구성 | CAGR % | MDD % | 샤프 | 연변동성 % | 월 평균 회전율 % | 누적 비용 % | 평균 보유 종목 | 지연 CAGR % | 지연 하락 %p | G1 | G2 | G3 | G4 |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|`);
    const row = (lab: string, x: ReturnType<typeof st>, xd: ReturnType<typeof st> | null, extra: string): string => `| ${lab} | ${f2(x.cagr)} | ${f2(x.mdd)} | ${f2(x.sharpe)} | ${f2(x.vol)} | ${f2(x.turnover)} | ${f2(x.cost)} | ${f2(x.avgN)} | ${xd ? f2(xd.cagr) : "-"} | ${xd ? f2(x.cagr - xd.cagr) : "-"} | ${extra}`;
    console.log(row("v2.1", s, sd, `${g.map(ox).join(" | ")} |`));
    console.log(row("K200P", k, kd, "| | | |"));
    console.log(row("POOL(v2 월간)", p, pd, "| | | |"));
    console.log(row("B&H 가격(069500 원주가)", b, null, "| | | |"));
    console.log(row("B&H 총수익(069500 수정, 참고)", bt, null, "| | | |"));
    console.log(row("KOSPI", ko, null, "| | | |"));
    console.log(`기준값: G1 ≥ ${f2(k.cagr + SMT_G1_MARGIN_PP)}, G2 > ${f2(b.cagr)}, G3 ≤ ${f2(k.mdd + SMT_G3_MDD_MARGIN_PP)}, G4 하락 ≤ ${SMT_G4_MAX_DELAY_DROP_PP}`);
  }

  console.log("\n=== 연도별 수익률 % ===\n| 연도 | v2.1 | K200P | B&H 가격 | K200P − B&H 가격 %p |\n|---|---|---|---|---|");
  for (let y = Number(firstExec.slice(0, 4)); y <= Number(dataEnd.slice(0, 4)); y++) {
    const k = yearRet(KP, y), b = yearRet(bhP, y);
    console.log(`| ${y} | ${f2(yearRet(V, y))} | ${f2(k)} | ${f2(b)} | ${f2(k - b)} |`);
  }

  // ---- R1~R3 ----
  const fullS = st(V, FULL), fullK = st(KP, FULL);
  console.log(`\n=== R1 주변 값 (전 기간; 기본 CAGR ${f2(fullS.cagr)}, 샤프 ${f2(fullS.sharpe)}, MDD ${f2(fullS.mdd)}; K200P CAGR ${f2(fullK.cagr)}) ===\n| 변형 | CAGR % | 샤프 | MDD % |\n|---|---|---|---|`);
  const r1 = (label: string, cfg: Cfg): void => { const s = st(run(targetsOf(cfg), false), FULL); console.log(`| ${label} | ${f2(s.cagr)} | ${f2(s.sharpe)} | ${f2(s.mdd)} |`); };
  for (const L of SMT_R1_LOOKBACKS) r1(`모멘텀 기간 ${L}개월(최근 1개월 제외)`, { ...BASE, L });
  for (const K of SMT_R1_TOP_KS) r1(`상·하위 ${K}개 업종`, { ...BASE, K });
  for (const [a, b] of SMT_R1_MULTS) r1(`배수 ${a}/${b}`, { ...BASE, mTop: a, mBot: b });

  const mk = (d: string): string => d.slice(0, 7);
  const mm2 = new Map<string, { s: number[]; w: number[]; idx: number[] }>();
  V.dates.forEach((d, i) => { if (d <= firstExec) return; const e = mm2.get(mk(d)) ?? { s: [], w: [], idx: [] }; e.s.push(V.ret[i]); e.w.push(KP.ret[i]); e.idx.push(i); mm2.set(mk(d), e); });
  let best = { m: "", ex: -Infinity };
  for (const [k, e] of mm2) { const ex = computeCumulativeAndMdd(e.s).totalReturnPct - computeCumulativeAndMdd(e.w).totalReturnPct; if (ex > best.ex) best = { m: k, ex }; }
  const repl = [...V.ret];
  for (const i of mm2.get(best.m)!.idx) repl[i] = KP.ret[i];
  console.log(`\n=== R2 상위 사건 제거 (비교 기준 K200P) ===\n| 바꾼 달 | 그 달 v2.1 − K200P %p | 바꾼 뒤 전 기간 CAGR % | 바꾸기 전 CAGR % | K200P CAGR % |\n|---|---|---|---|---|\n| ${best.m} | ${f2(best.ex)} | ${f2(st({ dates: V.dates, ret: repl }, FULL).cagr)} | ${f2(fullS.cagr)} | ${f2(fullK.cagr)} |`);

  const rng = mulberry32(SMT_R3_SEED);
  const orders = sigs.map((d) => rankedSectors(d, BASE.L));
  const cg: number[] = [], sh: number[] = [];
  for (let n = 0; n < SMT_R3_DRAWS; n++) {
    const tg = sigs.map((d, k) => {
      const a = [...orders[k]];
      for (let i = 0; i < a.length - 1; i++) { const j = i + Math.floor(rng() * (a.length - i)); [a[i], a[j]] = [a[j], a[i]]; }
      return weights(d, multMap(a, BASE), kAt);
    });
    const s = st(run(tg, false), FULL);
    cg.push(s.cagr); sh.push(s.sharpe);
  }
  const summ = (arr: number[], v: number): string => { const b = [...arr].sort((x, y) => x - y); return `${f2(b[Math.floor(b.length / 2)])} | ${f2(b[Math.floor(b.length * 0.95)])} | ${f2(b[b.length - 1])} | ${f2(v)} | ${arr.filter((x) => x >= v).length} | ${f2((arr.filter((x) => x < v).length / arr.length) * 100)}`; };
  console.log(`\n=== R3 무작위 업종 순위 (${SMT_R3_DRAWS}회, 시드 ${SMT_R3_SEED}, 전 기간) ===\n| 지표 | 무작위 중앙값 | 95분위 | 최대 | v2.1 | v2.1 이상 회수 | 백분위 |\n|---|---|---|---|---|---|---|`);
  console.log(`| CAGR % | ${summ(cg, fullS.cagr)} |`);
  console.log(`| 샤프 | ${summ(sh, fullS.sharpe)} |`);

  // ---- 최근 신호일 ----
  const dl = sigs[sigs.length - 1], kl = sigs.length - 1;
  const mom = sectorMom(dl, BASE.L), order = rankedSectors(dl, BASE.L), mmL = multMap(order, BASE);
  console.log(`\n=== 최근 신호일 ${dl} (체결 ${CAL[calIdx.get(dl)! + 1] ?? "-"}) K200P ${kAt(dl).length}종목, 업종 순위 (모멘텀 ${monthEnds[meIdx.get(dl)! - BASE.L]}~${monthEnds[meIdx.get(dl)! - SMT_SKIP_MONTHS]}) ===\n| 순위 | 업종 | 유효 종목 수 | 모멘텀 % | 배수 |\n|---|---|---|---|---|`);
  order.forEach((g, i) => console.log(`| ${i + 1} | ${secLabel(g)} | ${mom.get(g)!.n} | ${f2(mom.get(g)!.mom * 100)} | ${mmL.get(g) ?? 1} |`));
  for (const [lab, tg] of [["v2.1", tV], ["K200P", tK]] as [string, Target[]][]) {
    const w = tg[kl].w, other = (lab === "v2.1" ? tK : tV)[kl].w;
    console.log(`${lab} 비중 상위 10종목\n| 순위 | 코드 | 이름 | 업종 | ${lab} 비중 % | ${lab === "v2.1" ? "K200P" : "v2.1"} 비중 % |\n|---|---|---|---|---|---|`);
    [...w].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 10).forEach(([c, x], i) => console.log(`| ${i + 1} | ${c} | ${nameOf.get(c) ?? "-"} | ${secLabel(sectorOf(c))} | ${f2(x * 100)} | ${f2((other.get(c) ?? 0) * 100)} |`));
  }
  finish();

  function finish(): void {
    console.log("\n=== 실행 지표 ===");
    console.log(`Supabase 읽은 행: ${Object.entries(dbRead).map(([k, v]) => `${k} ${v}`).join(" | ")} | 합계 ${Object.values(dbRead).reduce((a, b) => a + b, 0)}`);
    console.log(`Supabase 쓴 행: 0 | 외부 요청 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });
