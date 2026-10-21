/**
 * [임시 연구 — 병합 금지, 읽기 전용, 외부 요청 0건(Storage 다운로드 제외)] 신용잔고 전략 CR1·CR2·CR3 백테스트.
 * 사전 등록: research/credit-tilt-prereg.md (커밋 1b6bf3f5). 정의·관문·선택 규칙은 그 문서가 고정한다. 숫자와 표, O/X만 출력한다.
 */
import { parquetReadObjects } from "hyparquet";
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
import { INVESTOR_FLOW_STOCK_STORE_BUCKET } from "@/lib/investorFlowConfig";
import { SCAN_CAP_EOK, SCAN_POOL_SIZE } from "@/lib/signalScanConfig";
import { FLOW_TILT_ENDED_GRACE_DAYS } from "@/lib/foreignFlowTiltConfig";
import { LV_QUARTER_MONTHS, LV_FIRST_SIGNAL_MONTH, LV_LEARN, LV_CONFIRM, LV_HOLDOUT_FROM, LV_R3_DRAWS, LV_R3_TOP_FRACTION, LV_QUARTERS_PER_YEAR } from "@/lib/smallcapLowvolConfig";
import { SCS_CREDIT_LAG_DAYS, SCS_CREDIT_CARRY_MAX_DAYS, SCS_CREDIT_CLEAN_PREFIX } from "@/lib/shortCreditScanConfig";
import {
  CT_MULT_LOW, CT_MULT_MID, CT_MULT_HIGH, CT_GROUPS, CT_R1_GROUPS, CT_POOL_G1_MARGIN_PP, CT_POOL_G3_MDD_MARGIN_PP, CT_MID_G1_MARGIN_PP, CT_MID_G3_MDD_MARGIN_PP,
  CT_G4_MAX_DELAY_DROP_PP, CT_R3_SEED, CT_CREDIT_FIRST_YEAR, CT_CREDIT_LAST_YEAR,
} from "@/lib/creditTiltConfig";

const T0 = Date.now();
const MS_DAY = 86_400_000;
const f2 = (x: number): string => (Number.isFinite(x) ? x.toFixed(2) : "-");
const ox = (b: boolean): string => (b ? "O" : "X");
const dayDiff = (a: string, b: string): number => (Date.parse(b) - Date.parse(a)) / MS_DAY;
const dbRead: Record<string, number> = {};
const dl = { creditBytes: 0, creditRows: 0 };
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

interface S { code: string; idx: Map<string, number>; close: Float64Array; mcapRow: Float64Array; avgTvRow: Float64Array; last: string; CR: Float64Array; CA: Float64Array; lastCr: Int32Array }
interface Target { w: Map<string, number>; n: number }
interface Out { dates: string[]; ret: number[]; costFrac: number[]; turn: { d: string; v: number }[]; nPos: number[]; liq: string[] }
interface Win { from: string; to: string }
type Kind = "CR1" | "CR2" | "CR3" | "POOL" | "MEW";
type U = "POOL" | "MID";
type Sig = "C1" | "C3";
const VARIANTS: Kind[] = ["CR1", "CR2", "CR3"];
const DESC: Record<Kind, string> = { CR1: "CR1 POOL 틸트(하위×1.5·중간×1.0·상위×0.5)", CR2: "CR2 POOL 상위 1/3 제외 시총가중", CR3: "CR3 MID 상위 1/3 제외 동일가중", POOL: "POOL(상위 100 시총가중)", MEW: "MEW(MID 전체 동일가중)" };
const BENCH: Record<"CR1" | "CR2" | "CR3", Kind> = { CR1: "POOL", CR2: "POOL", CR3: "MEW" };
const UNIV: Record<Kind, U> = { CR1: "POOL", CR2: "POOL", POOL: "POOL", CR3: "MID", MEW: "MID" };

async function main(): Promise<void> {
  console.log(`신용잔고 전략 CR1~CR3 시작(읽기 전용): ${new Date().toISOString()} (사전등록 1b6bf3f5 이후)`);
  const adjustments = await loadAppliedAdjustments();
  dbRead["stock_price_adjustment_events(applied)"] = [...adjustments.values()].reduce((a, l) => a + l.length, 0);
  const series = await loadAllStockSeriesFromParquet(2010, new Date().getUTCFullYear());
  const today = new Date().toISOString().slice(0, 10);
  const kospi = await getIndexPriceSeries("KOSPI", "2009-01-01", today);
  const kosdaq = await getIndexPriceSeries("KOSDAQ", "2009-01-01", today);
  dbRead["beta_price_history(KOSPI)"] = kospi.length; dbRead["beta_price_history(KOSDAQ)"] = kosdaq.length;

  // ---- 신용잔고 정리본 (2009~2026, 신용잔고율·금액만) ----
  const creditBy = new Map<string, Map<string, [number, number]>>();
  for (let y = CT_CREDIT_FIRST_YEAR; y <= CT_CREDIT_LAST_YEAR; y++) {
    const { data, error } = await supabaseAdmin.storage.from(INVESTOR_FLOW_STOCK_STORE_BUCKET).download(`${SCS_CREDIT_CLEAN_PREFIX}/${y}.parquet`);
    if (error) { console.log(`${SCS_CREDIT_CLEAN_PREFIX}/${y}.parquet 없음`); continue; }
    const buf = await data.arrayBuffer();
    dl.creditBytes += buf.byteLength;
    for (const r of (await parquetReadObjects({ file: buf, columns: ["stock_code", "deal_date", "whol_loan_rmnd_rate", "whol_loan_rmnd_amt"] })) as { stock_code: string; deal_date: string; whol_loan_rmnd_rate: number | null; whol_loan_rmnd_amt: number | null }[]) {
      dl.creditRows++;
      let m = creditBy.get(r.stock_code);
      if (!m) { m = new Map(); creditBy.set(r.stock_code, m); }
      m.set(r.deal_date, [r.whol_loan_rmnd_rate === null ? NaN : Number(r.whol_loan_rmnd_rate), r.whol_loan_rmnd_amt === null ? NaN : Number(r.whol_loan_rmnd_amt)]);
    }
  }
  console.log(`신용잔고 정리본(2009~2026): 종목 ${creditBy.size}개, ${dl.creditRows}행, 다운로드 ${dl.creditBytes} B (${(dl.creditBytes / 1048576).toFixed(2)} MiB)`);

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
  const nCal = CAL.length, lastIdx = nCal - 1, dataEnd = CAL[lastIdx];
  const calIdx = new Map(CAL.map((d, i) => [d, i]));
  const monthEnds: string[] = [];
  for (let k = 0; k + 1 < nCal; k++) if (CAL[k].slice(0, 7) !== CAL[k + 1].slice(0, 7)) monthEnds.push(CAL[k]);
  const endedBefore = new Date(Date.parse(dataEnd) - FLOW_TILT_ENDED_GRACE_DAYS * MS_DAY).toISOString().slice(0, 10);
  const firstSignal = monthEnds.find((d) => d.slice(0, 7) === LV_FIRST_SIGNAL_MONTH)!;
  const quarterSignals = monthEnds.filter((d) => d >= firstSignal && (LV_QUARTER_MONTHS as readonly number[]).includes(Number(d.slice(5, 7))));
  const monthlySignals = monthEnds.filter((d) => d >= firstSignal);
  const firstExec = CAL[calIdx.get(firstSignal)! + 1];
  console.log(`종목 ${rows0.length}개, 거래일(2010~) ${nCal}일 ${CAL[0]}~${dataEnd}, 분기 신호 ${quarterSignals.length}개(첫 신호 ${firstSignal}, 첫 체결 ${firstExec}), 월간 신호 ${monthlySignals.length}개`);
  void lastIdx;

  const isElig = (r: { mcap: Float64Array; avgTv: Float64Array }, i: number): boolean => i >= 1 && r.mcap[i - 1] >= SCAN_CAP_EOK && r.avgTv[i] >= PIT_MIN_AVG_TRADING_VALUE_WON;
  const cand = rows0.filter((r) => { for (let i = 1; i < r.dates.length; i++) if (r.dates[i] >= "2010-01-01" && isElig(r, i)) return true; return false; });
  console.log(`PIT 적격이 된 적 있는 종목 ${cand.length}개`);
  const stocks: S[] = cand.map((r) => {
    const idx = new Map(r.dates.map((d, i) => [d, i]));
    const CR = new Float64Array(nCal).fill(NaN), CA = new Float64Array(nCal).fill(NaN), lastCr = new Int32Array(nCal).fill(-1);
    const cm = creditBy.get(r.code);
    let last = -1;
    for (let c = 0; c < nCal; c++) { const v = cm?.get(CAL[c]); if (v) { CR[c] = v[0]; CA[c] = v[1]; last = c; } lastCr[c] = last; }
    return { code: r.code, idx, close: r.close, mcapRow: r.mcap, avgTvRow: r.avgTv, last: r.dates[r.dates.length - 1], CR, CA, lastCr };
  });
  stocks.sort((a, b) => (a.code < b.code ? -1 : 1));
  const byCode = new Map(stocks.map((s) => [s.code, s]));
  rows0.length = 0; creditBy.clear();

  // ---- 유니버스·신호 ----
  const uCache = new Map<string, S[]>();
  const universeAt = (u: U, d: string): S[] => {
    const key = `${u}|${d}`;
    let v = uCache.get(key);
    if (!v) {
      const e: { s: S; mcap: number }[] = [];
      for (const s of stocks) { const i = s.idx.get(d); if (i !== undefined && isElig({ mcap: s.mcapRow, avgTv: s.avgTvRow }, i)) e.push({ s, mcap: s.mcapRow[i] }); }
      const sorted = e.sort((a, b) => b.mcap - a.mcap || (a.s.code < b.s.code ? -1 : 1)).map((x) => x.s);
      v = u === "POOL" ? sorted.slice(0, SCAN_POOL_SIZE) : sorted.slice(SCAN_POOL_SIZE);
      uCache.set(key, v);
    }
    return v;
  };
  const mcapAt = (s: S, d: string): number => s.mcapRow[s.idx.get(d)!];
  const sigAt = (s: S, d: string, sig: Sig): number => {
    const j = calIdx.get(d)! - SCS_CREDIT_LAG_DAYS;
    if (j < 0) return NaN;
    const li = s.lastCr[j];
    if (li < 0 || j - li > SCS_CREDIT_CARRY_MAX_DAYS) return NaN;
    if (sig === "C1") return s.CR[li];
    const m = mcapAt(s, d);
    return m > 0 && Number.isFinite(s.CA[li]) ? s.CA[li] / m : NaN;
  };
  /** 그룹: 0 = 상위(신용 많음), 1 = 중간, 2 = 하위(신용 적음). 신호 없는 종목은 중간. parts = 3(기본) 또는 4(R1). */
  function groupsAt(u: U, d: string, sig: Sig, parts: number): { members: S[]; grp: Map<string, number> } {
    const members = universeAt(u, d);
    const items = members.map((s) => ({ s, v: sigAt(s, d, sig) })).filter((x) => Number.isFinite(x.v)).sort((a, b) => b.v - a.v || (a.s.code < b.s.code ? -1 : 1));
    const grp = new Map<string, number>(members.map((s) => [s.code, 1]));
    const n = items.length;
    items.forEach((x, i) => { const g = Math.floor((i * parts) / n); grp.set(x.s.code, g === 0 ? 0 : g === parts - 1 ? 2 : 1); });
    return { members, grp };
  }
  const weightsFor = (kind: Kind, members: S[], grp: Map<string, number>, d: string): Target => {
    const w = new Map<string, number>();
    if (kind === "MEW" || kind === "CR3") {
      const sel = kind === "MEW" ? members : members.filter((s) => grp.get(s.code) !== 0);
      for (const s of sel) w.set(s.code, 1 / sel.length);
      return { w, n: sel.length };
    }
    const mult = (s: S): number => (kind === "POOL" ? 1 : kind === "CR2" ? (grp.get(s.code) === 0 ? 0 : 1) : [CT_MULT_HIGH, CT_MULT_MID, CT_MULT_LOW][grp.get(s.code)!]);
    let tot = 0;
    for (const s of members) { const x = mcapAt(s, d) * mult(s); if (x > 0) { w.set(s.code, x); tot += x; } }
    for (const [k, x] of w) w.set(k, x / tot);
    return { w, n: w.size };
  };
  const targetsOf = (kind: Kind, sigs: string[], sig: Sig = "C1", parts = CT_GROUPS): Target[] => sigs.map((d) => { const { members, grp } = groupsAt(UNIV[kind], d, sig, parts); return weightsFor(kind, members, grp, d); });

  const buyRate = computeEffectiveBuyPrice(1) - 1;
  const sellRate = (d: string): number => 1 - computeEffectiveSellPrice(1, d, "KR");

  // ---- 엔진 ----
  function run(targets: Target[], sigs: string[], delay: boolean, endD: string): Out {
    const execAt = new Map<string, Target>();
    sigs.forEach((d, k) => { const j = calIdx.get(d)! + 1 + (delay ? 1 : 0); if (j < nCal && k < targets.length) execAt.set(CAL[j], targets[k]); });
    let cash = 1, prevV = 1;
    const pos = new Map<string, { val: number; last: number }>();
    const out: Out = { dates: [], ret: [], costFrac: [], turn: [], nPos: [], liq: [] };
    for (let c = calIdx.get(firstExec)!; c < nCal; c++) {
      const d = CAL[c];
      if (d > endD) break;
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

  // ---- 지표 ----
  function st(o: { dates: string[]; ret: number[]; costFrac?: number[]; turn?: { d: string; v: number }[]; nPos?: number[]; liq?: string[] }, win: Win, retOverride?: number[]) {
    const to = win.to > dataEnd ? dataEnd : win.to;
    const idx: number[] = [];
    for (let i = 0; i < o.dates.length; i++) if (o.dates[i] >= win.from && o.dates[i] <= win.to && o.dates[i] > firstExec) idx.push(i);
    const r = idx.map((i) => (retOverride ? retOverride[i] : o.ret[i]));
    const { totalReturnPct, mddPct } = computeCumulativeAndMdd(r);
    const cagr = computeCagrPct(totalReturnPct, win.from, to);
    const m = r.reduce((a, x) => a + x, 0) / Math.max(r.length, 1);
    const sd = Math.sqrt(r.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(r.length - 1, 1));
    const yrs = Math.max(dayDiff(win.from, to) / 365.25, 1e-9);
    return {
      cagr, mdd: mddPct, sharpe: sd > 0 ? (m * ETF_TRADING_DAYS_PER_YEAR) / (sd * Math.sqrt(ETF_TRADING_DAYS_PER_YEAR)) : NaN, vol: sd * Math.sqrt(ETF_TRADING_DAYS_PER_YEAR),
      turnover: o.turn ? (o.turn.filter((x) => x.d >= win.from && x.d <= win.to && x.d > firstExec).reduce((a, x) => a + x.v, 0) / (yrs * LV_QUARTERS_PER_YEAR)) * 100 : NaN,
      cost: o.costFrac ? idx.reduce((a, i) => a + o.costFrac![i], 0) * 100 : NaN,
      avgN: o.nPos ? idx.reduce((a, i) => a + o.nPos![i], 0) / Math.max(idx.length, 1) : NaN,
      liq: o.liq ? o.liq.filter((d) => d >= win.from && d <= win.to && d > firstExec).length : NaN,
    };
  }
  type Stat = ReturnType<typeof st>;
  const yearRet = (o: { dates: string[]; ret: number[] }, y: number, win: Win): number => computeCumulativeAndMdd(o.ret.filter((_, i) => o.dates[i].startsWith(`${y}-`) && o.dates[i] >= win.from && o.dates[i] <= win.to && o.dates[i] > firstExec)).totalReturnPct;

  // ---- B&H, KOSDAQ, KOSPI ----
  const rawEtf: { date: string; px: number }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabaseAdmin.from("etf_daily_prices").select("trade_date, adj_close").eq("code", SEASON_STOCK_CODE).order("trade_date").range(from, from + 999);
    if (error) throw new Error(`etf_daily_prices: ${error.message}`);
    for (const r of data ?? []) rawEtf.push({ date: r.trade_date as string, px: Number(r.adj_close) });
    dbRead["etf_daily_prices(069500)"] = (dbRead["etf_daily_prices(069500)"] ?? 0) + (data?.length ?? 0);
    if (!data || data.length < 1000) break;
  }
  const kRetByDate = new Map<string, number>();
  for (let i = 1; i < kospi.length; i++) kRetByDate.set(kospi[i].tradeDate, kospi[i].closePrice / kospi[i - 1].closePrice - 1);
  const etf = rawEtf.map((x) => ({ ...x }));
  {
    const r = rawEtf.map((x, i) => (i === 0 ? NaN : x.px / rawEtf[i - 1].px - 1));
    let nCh = 0;
    for (let t = 1; t + 1 < rawEtf.length; t++) {
      if (!(Math.abs(r[t]) > ETF_SPIKE_MIN_ABS_RET) || !(Math.sign(r[t + 1]) === -Math.sign(r[t])) || !(Math.abs((1 + r[t]) * (1 + r[t + 1]) - 1) < ETF_SPIKE_MAX_NET_ABS)) continue;
      const kr = kRetByDate.get(rawEtf[t].date);
      if (kr !== undefined && Math.sign(kr) === Math.sign(r[t]) && Math.abs(kr) >= ETF_SPIKE_KOSPI_EXEMPT_RATIO * Math.abs(r[t])) continue;
      etf[t].px = Math.sqrt(rawEtf[t - 1].px * rawEtf[t + 1].px); nCh++;
    }
    console.log(`069500 정제로 바꾼 날 ${nCh}개`);
  }
  const bh = { dates: etf.slice(1).map((x) => x.date), ret: etf.slice(1).map((x, i) => (x.px / etf[i].px - 1) * 100) };
  const idxSeries = (pts: typeof kospi): { dates: string[]; ret: number[] } => { const p = pts.filter((x) => x.tradeDate >= "2009-12-01"); return { dates: p.slice(1).map((x) => x.tradeDate), ret: computeIndexDailyReturnsPct(p as never) }; };
  const kos = idxSeries(kospi), kdq = idxSeries(kosdaq);
  console.log(`KOSDAQ 지수 ${kosdaq.length}행 ${kosdaq[0]?.tradeDate}~${kosdaq[kosdaq.length - 1]?.tradeDate}`);


  const LEARN: Win = { ...LV_LEARN }, CONFIRM: Win = { ...LV_CONFIRM }, HOLD: Win = { from: LV_HOLDOUT_FROM, to: "9999-12-31" }, FULL: Win = { from: LV_LEARN.from, to: "9999-12-31" };
  const marginOf = (k: "CR1" | "CR2" | "CR3"): number => (k === "CR3" ? CT_MID_G1_MARGIN_PP : CT_POOL_G1_MARGIN_PP);
  const gatesOf = (k: "CR1" | "CR2" | "CR3", x: Stat, bench: Stat, b: Stat, drop: number): boolean[] => [
    x.cagr >= bench.cagr + marginOf(k), x.cagr > b.cagr,
    k === "CR3" ? x.mdd <= b.mdd + CT_MID_G3_MDD_MARGIN_PP : x.mdd <= bench.mdd + CT_POOL_G3_MDD_MARGIN_PP, drop <= CT_G4_MAX_DELAY_DROP_PP,
  ];
  const HEAD = "| 구성 | CAGR % | MDD % | 샤프 | 연변동성 % | 분기 평균 회전율 % | 누적 비용 % | 평균 보유 종목 수 | 폐지 청산 건수 | 지연 CAGR % | 하락 %p | G1 | G2 | G3 | G4 |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|";
  const row = (lab: string, s: Stat, extra: string): string => `| ${lab} | ${f2(s.cagr)} | ${f2(s.mdd)} | ${f2(s.sharpe)} | ${f2(s.vol)} | ${f2(s.turnover)} | ${f2(s.cost)} | ${f2(s.avgN)} | ${Number.isFinite(s.liq) ? s.liq : "-"} | ${extra}`;
  const refRow = (lab: string, s: Stat): string => `| ${lab} | ${f2(s.cagr)} | ${f2(s.mdd)} | ${f2(s.sharpe)} | ${f2(s.vol)} | - | - | - | - | | | | | | |`;
  const yrsOf = (win: Win): number[] => { const a: number[] = []; for (let y = Number(win.from.slice(0, 4)); y <= Math.min(Number(win.to.slice(0, 4)), Number(dataEnd.slice(0, 4))); y++) a.push(y); return a; };

  // ---- 학습 ----
  const learnSigs = quarterSignals.filter((d) => d <= LEARN.to);
  const tgt = new Map<Kind, Target[]>();
  for (const k of [...VARIANTS, "POOL", "MEW"] as Kind[]) tgt.set(k, targetsOf(k, learnSigs));
  const L: Record<string, { base: Out; delay?: Out }> = {};
  for (const k of VARIANTS) L[k] = { base: run(tgt.get(k)!, learnSigs, false, LEARN.to), delay: run(tgt.get(k)!, learnSigs, true, LEARN.to) };
  for (const k of ["POOL", "MEW"] as Kind[]) L[k] = { base: run(tgt.get(k)!, learnSigs, false, LEARN.to) };
  const sL = new Map<string, Stat>();
  for (const k of [...VARIANTS, "POOL", "MEW"] as Kind[]) sL.set(k, st(L[k].base, LEARN));
  const bhL = st(bh, LEARN), kL = st(kos, LEARN), dL = st(kdq, LEARN);
  console.log(`\n=== (b) 학습 ${LEARN.from}~${LEARN.to} ===\n${HEAD}`);
  const qual = new Map<Kind, { ok: boolean; excess: number; turn: number }>();
  for (const k of VARIANTS as ("CR1" | "CR2" | "CR3")[]) {
    const s = sL.get(k)!, sd = st(L[k].delay!, LEARN), drop = s.cagr - sd.cagr, bench = sL.get(BENCH[k])!, g = gatesOf(k, s, bench, bhL, drop);
    qual.set(k, { ok: g.every(Boolean), excess: s.cagr - bench.cagr, turn: s.turnover });
    console.log(row(DESC[k], s, `${f2(sd.cagr)} | ${f2(drop)} | ${g.map(ox).join(" | ")} |`));
  }
  console.log(row(DESC.POOL, sL.get("POOL")!, "| | | | | |"));
  console.log(row(DESC.MEW, sL.get("MEW")!, "| | | | | |"));
  console.log(refRow("B&H(069500)", bhL)); console.log(refRow("KOSPI", kL)); console.log(refRow("KOSDAQ", dL));
  const pL = sL.get("POOL")!, mL = sL.get("MEW")!;
  console.log(`기준: CR1·CR2 — G1 ≥ POOL ${f2(pL.cagr)} + ${CT_POOL_G1_MARGIN_PP} = ${f2(pL.cagr + CT_POOL_G1_MARGIN_PP)}, G2 > B&H ${f2(bhL.cagr)}, G3 MDD ≤ POOL ${f2(pL.mdd)} + ${CT_POOL_G3_MDD_MARGIN_PP} = ${f2(pL.mdd + CT_POOL_G3_MDD_MARGIN_PP)}, G4 ≤ ${CT_G4_MAX_DELAY_DROP_PP} | CR3 — G1 ≥ MEW ${f2(mL.cagr)} + ${CT_MID_G1_MARGIN_PP} = ${f2(mL.cagr + CT_MID_G1_MARGIN_PP)}, G2 > B&H ${f2(bhL.cagr)}, G3 MDD ≤ B&H ${f2(bhL.mdd)} + ${CT_MID_G3_MDD_MARGIN_PP} = ${f2(bhL.mdd + CT_MID_G3_MDD_MARGIN_PP)}, G4 ≤ ${CT_G4_MAX_DELAY_DROP_PP}`);
  console.log(`연도별 수익률 %\n| 연도 | CR1 | CR2 | CR3 | POOL | MEW | B&H |\n|---|---|---|---|---|---|---|`);
  for (const y of yrsOf(LEARN)) console.log(`| ${y} | ${(["CR1", "CR2", "CR3", "POOL", "MEW"] as Kind[]).map((k) => f2(yearRet(L[k].base, y, LEARN))).join(" | ")} | ${f2(yearRet(bh, y, LEARN))} |`);

  const qualified = VARIANTS.filter((k) => qual.get(k)!.ok).sort((a, b) => qual.get(b)!.excess - qual.get(a)!.excess || qual.get(a)!.turn - qual.get(b)!.turn || (a < b ? -1 : 1));
  console.log("\n=== (c) 선택 결과 ===");
  if (!qualified.length) { console.log("선택 없음 (G1~G4 전부 O인 변형 0개) — 확인 계산을 하지 않고 종료합니다."); return finish(); }
  const sel = qualified[0] as "CR1" | "CR2" | "CR3", bk = BENCH[sel];
  console.log(`G1~G4 전부 O 변형 ${qualified.length}개: ${qualified.map((k) => `${k}(자기 비교 기준 대비 ${f2(qual.get(k)!.excess)}%p)`).join(", ")} → 선택: ${sel} (비교 기준 ${bk})`);

  const tS = targetsOf(sel, quarterSignals), tB = targetsOf(bk, quarterSignals);
  const FB = run(tS, quarterSignals, false, "9999-12-31"), FD = run(tS, quarterSignals, true, "9999-12-31"), FW = run(tB, quarterSignals, false, "9999-12-31");
  const stage = (label: string, win: Win): boolean => {
    const s = st(FB, win), sd = st(FD, win), w = st(FW, win), b = st(bh, win), k = st(kos, win), q = st(kdq, win);
    const drop = s.cagr - sd.cagr, g = gatesOf(sel, s, w, b, drop);
    console.log(`\n=== ${label} ${win.from}~${win.to > dataEnd ? dataEnd : win.to} ===\n${HEAD}`);
    console.log(row(DESC[sel], s, `${f2(sd.cagr)} | ${f2(drop)} | ${g.map(ox).join(" | ")} |`));
    console.log(row(DESC[bk], w, "| | | | | |"));
    console.log(refRow("B&H(069500)", b)); console.log(refRow("KOSPI", k)); console.log(refRow("KOSDAQ", q));
    console.log(`기준: G1 ≥ ${f2(w.cagr + marginOf(sel))}, G2 > ${f2(b.cagr)}, G3 ≤ ${f2(sel === "CR3" ? b.mdd + CT_MID_G3_MDD_MARGIN_PP : w.mdd + CT_POOL_G3_MDD_MARGIN_PP)}, G4 하락 ≤ ${CT_G4_MAX_DELAY_DROP_PP}`);
    console.log(`연도별 수익률 %\n| 연도 | ${sel} | ${bk} | B&H |\n|---|---|---|---|`);
    for (const y of yrsOf(win)) console.log(`| ${y} | ${f2(yearRet(FB, y, win))} | ${f2(yearRet(FW, y, win))} | ${f2(yearRet(bh, y, win))} |`);
    return g.every(Boolean);
  };
  if (!stage("(d) 확인", CONFIRM)) { console.log("\n확인 결과: 통과 아님 (홀드아웃 계산하지 않음)"); return finish(); }
  console.log("\n홀드아웃 계산 실행 → 누적 시도 +1 (136)");
  if (!stage("(d) 홀드아웃", HOLD)) { console.log("\n홀드아웃 결과: 통과 아님 (R1~R3 계산하지 않음)"); return finish(); }

  // ---- 추가 검증 ----
  const fullS = st(FB, FULL), fullW = st(FW, FULL), thr = fullW.cagr + marginOf(sel);
  console.log(`\n=== (e) 추가 검증 R1~R3 (전 기간 ${FULL.from}~${dataEnd}; 전략 CAGR ${f2(fullS.cagr)}, ${bk} CAGR ${f2(fullW.cagr)}, 기준 ${f2(thr)}) ===`);
  const r1: { label: string; cagr: number; ok: boolean }[] = [];
  { const s = st(run(targetsOf(sel, quarterSignals, "C3"), quarterSignals, false, "9999-12-31"), FULL); r1.push({ label: "C1 대신 C3(시총 대비 신용잔고 금액)", cagr: s.cagr, ok: s.cagr >= thr }); }
  { const s = st(run(targetsOf(sel, monthlySignals), monthlySignals, false, "9999-12-31"), FULL); r1.push({ label: "매월 리밸런싱", cagr: s.cagr, ok: s.cagr >= thr }); }
  { const s = st(run(targetsOf(sel, quarterSignals, "C1", CT_R1_GROUPS), quarterSignals, false, "9999-12-31"), FULL); r1.push({ label: "4등분(상위 1/4 기준)", cagr: s.cagr, ok: s.cagr >= thr }); }
  console.log("R1\n| 조합 | 전 기간 CAGR % | O/X |\n|---|---|---|");
  for (const x of r1) console.log(`| ${x.label} | ${f2(x.cagr)} | ${ox(x.ok)} |`);
  const r1ok = r1.every((x) => x.ok);
  const qk = (d: string): string => `${d.slice(0, 4)}-Q${Math.floor((Number(d.slice(5, 7)) - 1) / 3) + 1}`;
  const qm = new Map<string, { s: number[]; w: number[]; idx: number[] }>();
  FB.dates.forEach((d, i) => { if (d < FULL.from || d <= firstExec) return; const k = qk(d); const e = qm.get(k) ?? { s: [], w: [], idx: [] }; e.s.push(FB.ret[i]); e.w.push(FW.ret[i]); e.idx.push(i); qm.set(k, e); });
  let best = { q: "", ex: -Infinity };
  for (const [k, e] of qm) { const ex = computeCumulativeAndMdd(e.s).totalReturnPct - computeCumulativeAndMdd(e.w).totalReturnPct; if (ex > best.ex) best = { q: k, ex }; }
  const repl = [...FB.ret];
  for (const i of qm.get(best.q)!.idx) repl[i] = FW.ret[i];
  const r2s = st(FB, FULL, repl), r2ok = r2s.cagr >= thr;
  console.log(`R2: ${bk} 대비 분기 초과 수익 최대 ${best.q} (${f2(best.ex)}%p) 를 ${bk} 수익으로 바꾼 전 기간 CAGR ${f2(r2s.cagr)} vs 기준 ${f2(thr)} → ${ox(r2ok)}`);
  const rng = mulberry32(CT_R3_SEED);
  const base = quarterSignals.map((d) => groupsAt(UNIV[sel], d, "C1", CT_GROUPS));
  let ge = 0;
  const draws: number[] = [];
  for (let n = 0; n < LV_R3_DRAWS; n++) {
    const tg: Target[] = quarterSignals.map((d, k) => {
      const { members, grp } = base[k];
      const nTop = [...grp.values()].filter((g) => g === 0).length, nBot = [...grp.values()].filter((g) => g === 2).length;
      const a = [...members];
      for (let i = 0; i < a.length - 1; i++) { const j = i + Math.floor(rng() * (a.length - i)); [a[i], a[j]] = [a[j], a[i]]; }
      const rg = new Map<string, number>();
      a.forEach((s, i) => rg.set(s.code, i < nTop ? 0 : i < nTop + nBot ? 2 : 1));
      return weightsFor(sel, members, rg, d);
    });
    const c = st(run(tg, quarterSignals, false, "9999-12-31"), FULL).cagr;
    draws.push(c);
    if (c >= fullS.cagr) ge++;
  }
  draws.sort((a, b) => a - b);
  const r3p = ge / LV_R3_DRAWS, r3ok = r3p <= LV_R3_TOP_FRACTION;
  console.log(`R3: 무작위 그룹 배정 ${LV_R3_DRAWS}회(시드 ${CT_R3_SEED}) 전 기간 CAGR 중앙값 ${f2(draws[Math.floor(draws.length / 2)])}, 95분위 ${f2(draws[Math.floor(draws.length * 0.95)])}, 최대 ${f2(draws[draws.length - 1])}; 전략 ${f2(fullS.cagr)} 이상 ${ge}회 (${f2(r3p * 100)}%) → ${ox(r3ok)} (기준 상위 ${LV_R3_TOP_FRACTION * 100}% 이내)`);
  console.log(`\n최종: ${r1ok && r2ok && r3ok ? "통과" : "통과 아님"} (R1 ${ox(r1ok)} R2 ${ox(r2ok)} R3 ${ox(r3ok)})`);
  finish();

  function finish(): void {
    console.log("\n=== (f) 실행 지표 ===");
    console.log(`Supabase 읽은 행: ${Object.entries(dbRead).map(([k, v]) => `${k} ${v}`).join(" | ")} | 합계 ${Object.values(dbRead).reduce((a, b) => a + b, 0)}`);
    console.log(`Storage 다운로드: 신용잔고 정리본 ${dl.creditRows}행 ${dl.creditBytes} B (${(dl.creditBytes / 1048576).toFixed(2)} MiB) | Supabase 쓴 행: 0 | 외부 요청 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });
