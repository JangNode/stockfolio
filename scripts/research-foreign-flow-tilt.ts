/**
 * [임시 연구 — 병합 금지, 읽기 전용, 외부 요청 0건(Storage 다운로드 제외)] 대형주 외국인 수급 틸트 K1·K2·K3.
 * 사전 등록: research/foreign-flow-tilt-prereg.md (커밋 792bf6df). 정의·선택 규칙은 그 문서가 고정한다. 숫자와 표, O/X만 출력한다.
 */
import { parquetReadObjects } from "hyparquet";
import { getIndexPriceSeries } from "@/lib/betaPriceHistoryStorage";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadAllStockSeriesFromParquet } from "@/lib/stockDailyPricesStorage";
import { loadAppliedAdjustments } from "@/lib/stockPriceAdjustmentsStorage";
import { computeTrailingAvgTradingValue } from "@/lib/pitUniverse";
import { PIT_LIQUIDITY_LOOKBACK_DAYS, PIT_MIN_AVG_TRADING_VALUE_WON, STOCK_DATA_EARLIEST_YEAR } from "@/lib/strategyBacktestSummaryConfig";
import { computeCumulativeAndMdd, computeCagrPct } from "@/lib/strategyBacktestSummary";
import { computeIndexDailyReturnsPct } from "@/lib/benchmarkSummary";
import { computeEffectiveBuyPrice, computeEffectiveSellPrice } from "@/lib/transactionCost";
import { ETF_SPIKE_MIN_ABS_RET, ETF_SPIKE_MAX_NET_ABS, ETF_SPIKE_KOSPI_EXEMPT_RATIO, ETF_TRADING_DAYS_PER_YEAR } from "@/lib/etfAllocationConfig";
import { SEASON_STOCK_CODE } from "@/lib/seasonalityConfig";
import { INVESTOR_FLOW_STOCK_STORE_BUCKET, INVESTOR_FLOW_STOCK_FIRST_YEAR } from "@/lib/investorFlowConfig";
import {
  FLOW_TILT_CAP_EOK, FLOW_TILT_POOL_SIZE, FLOW_TILT_WINDOW_DAYS, FLOW_TILT_R1_WINDOW_DAYS, FLOW_TILT_MIN_PRICE_DAY_RATIO, FLOW_TILT_MULT, FLOW_TILT_K2_TOP_N,
  FLOW_TILT_CLEAN_PREFIX, FLOW_TILT_FIRST_SIGNAL_MONTH, FLOW_TILT_LEARN, FLOW_TILT_CONFIRM, FLOW_TILT_HOLDOUT_FROM, FLOW_TILT_G1_CAGR_MARGIN_PP,
  FLOW_TILT_G3_MDD_MARGIN_PP, FLOW_TILT_G4_MAX_DELAY_DROP_PP, FLOW_TILT_R_CAGR_MARGIN_PP, FLOW_TILT_R3_DRAWS, FLOW_TILT_R3_SEED, FLOW_TILT_R3_TOP_FRACTION,
  FLOW_TILT_ENDED_GRACE_DAYS,
} from "@/lib/foreignFlowTiltConfig";

const T0 = Date.now();
const MS_DAY = 86_400_000;
const f2 = (x: number): string => (Number.isFinite(x) ? x.toFixed(2) : "-");
const ox = (b: boolean): string => (b ? "O" : "X");
const dayDiff = (a: string, b: string): number => (Date.parse(b) - Date.parse(a)) / MS_DAY;
const dbRead: Record<string, number> = {};
let flowBytes = 0, flowRows = 0;

interface Sk { code: string; close: Float64Array; mcap: Float64Array; avgTv: Float64Array; idx: Map<string, number>; last: string }
interface El { sk: Sk; mcap: number }
interface Str { sk: Sk; mcap: number; f: number; fo: number }
interface Plan { d: string; pool: El[]; str: Str[]; nNoFlow: number }
interface Out { dates: string[]; ret: number[]; costFrac: number[]; turn: { d: string; v: number }[]; nPos: number[] }
interface Win { from: string; to: string }
type Kind = "K1" | "K2" | "K3" | "POOL";
type Stat = ReturnType<typeof makeSt>;
const VARIANTS: Kind[] = ["K1", "K2", "K3"];
const DESC: Record<Kind, string> = { K1: "K1 외국인 틸트", K2: "K2 외국인 선별(상위 30)", K3: "K3 외국인+기관 틸트", POOL: "POOL" };
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const makeSt = (cagr: number, mdd: number, sharpe: number, vol: number, turnover: number, cost: number, avgN: number) => ({ cagr, mdd, cm: mdd > 0 ? cagr / mdd : NaN, sharpe, vol, turnover, cost, avgN });

async function readEtf(code: string): Promise<{ date: string; px: number }[]> {
  const rows: { date: string; px: number }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabaseAdmin.from("etf_daily_prices").select("trade_date, adj_close").eq("code", code).order("trade_date").range(from, from + 999);
    if (error) throw new Error(`etf_daily_prices 읽기 실패 ${code}: ${error.message}`);
    for (const r of data ?? []) rows.push({ date: r.trade_date as string, px: Number(r.adj_close) });
    dbRead[`etf_daily_prices(${code})`] = (dbRead[`etf_daily_prices(${code})`] ?? 0) + (data?.length ?? 0);
    if (!data || data.length < 1000) break;
  }
  return rows;
}

async function main(): Promise<void> {
  console.log(`대형주 외국인 수급 틸트 K1~K3 시작(읽기 전용): ${new Date().toISOString()} (사전등록 792bf6df 이후)`);
  const adjustments = await loadAppliedAdjustments();
  dbRead["stock_price_adjustment_events(applied)"] = [...adjustments.values()].reduce((a, l) => a + l.length, 0);
  const series = await loadAllStockSeriesFromParquet(STOCK_DATA_EARLIEST_YEAR, new Date().getUTCFullYear(), adjustments);
  const kospi = await getIndexPriceSeries("KOSPI", "2009-01-01", new Date().toISOString().slice(0, 10));
  dbRead["beta_price_history(KOSPI)"] = kospi.length;

  // ---- 수급 정리본 (Storage 다운로드) ----
  const flowBy = new Map<string, Map<string, [number, number]>>();
  for (let y = INVESTOR_FLOW_STOCK_FIRST_YEAR; y <= new Date().getUTCFullYear(); y++) {
    const { data, error } = await supabaseAdmin.storage.from(INVESTOR_FLOW_STOCK_STORE_BUCKET).download(`${FLOW_TILT_CLEAN_PREFIX}/${y}.parquet`);
    if (error) { console.log(`정리본 ${y}.parquet 없음`); continue; }
    const buf = await data.arrayBuffer();
    flowBytes += buf.byteLength;
    for (const r of (await parquetReadObjects({ file: buf })) as { stock_code: string; trade_date: string; frgn_ntby_amt: number | null; orgn_ntby_amt: number | null }[]) {
      let m = flowBy.get(r.stock_code);
      if (!m) { m = new Map(); flowBy.set(r.stock_code, m); }
      m.set(r.trade_date, [r.frgn_ntby_amt ?? 0, r.orgn_ntby_amt ?? 0]);
      flowRows++;
    }
  }
  console.log(`수급 정리본: 종목 ${flowBy.size}개, ${flowRows}행, 다운로드 ${flowBytes} B (${(flowBytes / 1048576).toFixed(2)} MiB)`);

  const stocks: Sk[] = [];
  const calSet = new Set<string>();
  for (const [code, rows] of series) {
    for (const r of rows) if (r.tradeDate >= "2010-01-01") calSet.add(r.tradeDate);
    stocks.push({ code, close: Float64Array.from(rows.map((r) => r.closePrice)), mcap: Float64Array.from(rows.map((r) => r.marketCapEok)), avgTv: computeTrailingAvgTradingValue(rows, PIT_LIQUIDITY_LOOKBACK_DAYS), idx: new Map(rows.map((r, i) => [r.tradeDate, i])), last: rows[rows.length - 1].tradeDate });
    series.delete(code);
  }
  stocks.sort((a, b) => (a.code < b.code ? -1 : 1));
  const byCode = new Map(stocks.map((s) => [s.code, s]));
  const CAL = [...calSet].sort();
  const calIdx = new Map(CAL.map((d, i) => [d, i]));
  const dataEnd = CAL[CAL.length - 1];
  const monthEnds: string[] = [];
  for (let k = 0; k + 1 < CAL.length; k++) if (CAL[k].slice(0, 7) !== CAL[k + 1].slice(0, 7)) monthEnds.push(CAL[k]);
  const endedBefore = new Date(Date.parse(dataEnd) - FLOW_TILT_ENDED_GRACE_DAYS * MS_DAY).toISOString().slice(0, 10);
  const firstSignal = monthEnds.find((d) => d.slice(0, 7) === FLOW_TILT_FIRST_SIGNAL_MONTH)!;
  const signals = monthEnds.filter((d) => d >= firstSignal);
  const firstExec = CAL[calIdx.get(firstSignal)! + 1];
  console.log(`종목 ${stocks.length}개, 거래일(2010~) ${CAL.length}일 ${CAL[0]}~${dataEnd}, 월말 신호 ${signals.length}개 (첫 신호 ${firstSignal}, 첫 체결 ${firstExec})`);

  // ---- 풀·강도(플랜) ----
  const eligibleAt = (d: string): El[] => {
    const el: El[] = [];
    for (const sk of stocks) {
      const i = sk.idx.get(d);
      if (i === undefined || i < 1 || !(sk.mcap[i - 1] >= FLOW_TILT_CAP_EOK) || !(sk.avgTv[i] >= PIT_MIN_AVG_TRADING_VALUE_WON)) continue;
      el.push({ sk, mcap: sk.mcap[i] });
    }
    return el;
  };
  const poolCache = new Map<string, El[]>();
  const poolAt = (d: string): El[] => {
    let p = poolCache.get(d);
    if (!p) { p = eligibleAt(d).sort((a, b) => b.mcap - a.mcap || (a.sk.code < b.sk.code ? -1 : 1)).slice(0, FLOW_TILT_POOL_SIZE); poolCache.set(d, p); }
    return p;
  };
  const planCache = new Map<string, Plan>();
  function planAt(d: string, N: number): Plan {
    const key = `${d}|${N}`;
    let pl = planCache.get(key);
    if (pl) return pl;
    const pool = poolAt(d);
    const str: Str[] = [];
    let nNoFlow = 0;
    const c = calIdx.get(d)!;
    const minDays = Math.ceil(N * FLOW_TILT_MIN_PRICE_DAY_RATIO);
    for (const x of pool) {
      const fm = flowBy.get(x.sk.code);
      if (!fm) { nNoFlow++; continue; }
      if (c - N + 1 < 0 || !(x.mcap > 0)) continue;
      let days = 0, f = 0, o = 0;
      for (let j = c - N + 1; j <= c; j++) {
        const dd = CAL[j];
        const i = x.sk.idx.get(dd);
        if (i !== undefined && x.sk.close[i] > 0) days++;
        const v = fm.get(dd);
        if (v) { f += v[0]; o += v[1]; }
      }
      if (days < minDays) continue;
      str.push({ sk: x.sk, mcap: x.mcap, f: f / x.mcap, fo: (f + o) / x.mcap });
    }
    pl = { d, pool, str, nNoFlow };
    planCache.set(key, pl);
    return pl;
  }
  const groupOf = (i: number, n: number): number => Math.floor((i * 3) / n);
  const desc = (key: "f" | "fo") => (a: Str, b: Str): number => b[key] - a[key] || (a.sk.code < b.sk.code ? -1 : 1);
  /** 목표 비중. order가 있으면 정렬 대신 그 순서(R3 무작위 배정). */
  function targetFor(kind: Kind, pl: Plan, order?: (s: Str[]) => Str[]): Map<string, number> {
    if (kind === "POOL") { const t = pl.pool.reduce((a, x) => a + x.mcap, 0); return new Map(pl.pool.map((x) => [x.sk.code, x.mcap / t])); }
    const key: "f" | "fo" = kind === "K3" ? "fo" : "f";
    const sorted = order ? order(pl.str) : [...pl.str].sort(desc(key));
    const n = sorted.length;
    if (kind === "K2") {
      const sel = sorted.slice(0, Math.min(FLOW_TILT_K2_TOP_N, n));
      const t = sel.reduce((a, x) => a + x.mcap, 0);
      return new Map(sel.map((x) => [x.sk.code, x.mcap / t]));
    }
    const mult = new Map<string, number>();
    sorted.forEach((x, i) => mult.set(x.sk.code, FLOW_TILT_MULT[groupOf(i, n)]));
    const den = pl.pool.reduce((a, x) => a + x.mcap * (mult.get(x.sk.code) ?? 1), 0);
    return new Map(pl.pool.map((x) => [x.sk.code, (x.mcap * (mult.get(x.sk.code) ?? 1)) / den]));
  }

  // ---- 엔진 ----
  const buyRate = computeEffectiveBuyPrice(1) - 1;
  function run(targets: Map<string, number>[], delay: boolean, endD: string): Out {
    const execAt = new Map<string, Map<string, number>>();
    signals.forEach((d, k) => { const j = calIdx.get(d)! + 1 + (delay ? 1 : 0); if (j < CAL.length) execAt.set(CAL[j], targets[k]); });
    let cash = 1, prevV = 1;
    const pos = new Map<string, { val: number; last: number }>();
    const out: Out = { dates: [], ret: [], costFrac: [], turn: [], nPos: [] };
    for (const d of CAL) {
      if (d < firstExec) continue;
      if (d > endD) break;
      const sellRate = 1 - computeEffectiveSellPrice(1, d, "KR");
      let costF = 0;
      for (const [code, p] of [...pos.entries()]) {
        const sk = byCode.get(code)!;
        const i = sk.idx.get(d);
        if (i !== undefined) { p.val = (p.val * sk.close[i]) / p.last; p.last = sk.close[i]; }
        else if (sk.last < d && sk.last < endedBefore) { costF += (p.val * sellRate) / prevV; cash += p.val * (1 - sellRate); pos.delete(code); }
      }
      const now = execAt.get(d);
      if (now) {
        const V = cash + [...pos.values()].reduce((a, p) => a + p.val, 0);
        const tg = new Map<string, number>();
        for (const [code, w] of now) if (byCode.get(code)!.idx.has(d) && w > 0) tg.set(code, w);
        let buyN = 0, sellN = 0;
        for (const [code, p] of pos) if (!tg.has(code)) sellN += p.val;
        for (const [code, w] of tg) { const diff = w * V - (pos.get(code)?.val ?? 0); if (diff > 0) buyN += diff; else sellN += -diff; }
        const C = buyN * buyRate + sellN * sellRate, scale = V > 0 ? (V - C) / V : 1;
        pos.clear();
        let inv = 0;
        for (const [code, w] of tg) {
          const sk = byCode.get(code)!;
          const val = w * V * scale;
          pos.set(code, { val, last: sk.close[sk.idx.get(d)!] }); inv += val;
        }
        cash = V - C - inv;
        costF += V > 0 ? C / V : 0;
        if (buyN + sellN > 0) out.turn.push({ d, v: V > 0 ? (buyN + sellN) / 2 / V : 0 });
      }
      const V = cash + [...pos.values()].reduce((a, p) => a + p.val, 0);
      out.dates.push(d); out.ret.push((V / prevV - 1) * 100); out.costFrac.push(costF); out.nPos.push(pos.size);
      prevV = V;
    }
    return out;
  }
  const targetsOf = (kind: Kind, N: number): Map<string, number>[] => signals.map((d) => targetFor(kind, planAt(d, N)));

  // ---- 지표 ----
  function st(o: { dates: string[]; ret: number[]; costFrac?: number[]; turn?: { d: string; v: number }[]; nPos?: number[] }, win: Win, retOverride?: number[]): Stat {
    const to = win.to > dataEnd ? dataEnd : win.to;
    const idx: number[] = [];
    for (let i = 0; i < o.dates.length; i++) if (o.dates[i] >= win.from && o.dates[i] <= win.to && o.dates[i] > firstExec) idx.push(i);
    const r = idx.map((i) => (retOverride ? retOverride[i] : o.ret[i]));
    const { totalReturnPct, mddPct } = computeCumulativeAndMdd(r);
    const cagr = computeCagrPct(totalReturnPct, win.from, to);
    const m = r.reduce((a, x) => a + x, 0) / Math.max(r.length, 1);
    const sd = Math.sqrt(r.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(r.length - 1, 1));
    const yrs = Math.max(dayDiff(win.from, to) / 365.25, 1e-9);
    return makeSt(
      cagr, mddPct, sd > 0 ? (m * ETF_TRADING_DAYS_PER_YEAR) / (sd * Math.sqrt(ETF_TRADING_DAYS_PER_YEAR)) : NaN, sd * Math.sqrt(ETF_TRADING_DAYS_PER_YEAR),
      o.turn ? (o.turn.filter((x) => x.d >= win.from && x.d <= win.to && x.d > firstExec).reduce((a, x) => a + x.v, 0) / (yrs * 12)) * 100 : NaN,
      o.costFrac ? idx.reduce((a, i) => a + o.costFrac![i], 0) * 100 : NaN,
      o.nPos ? idx.reduce((a, i) => a + o.nPos![i], 0) / Math.max(idx.length, 1) : NaN,
    );
  }
  const yearRet = (o: { dates: string[]; ret: number[] }, y: number, win: Win): number => computeCumulativeAndMdd(o.ret.filter((_, i) => o.dates[i].startsWith(`${y}-`) && o.dates[i] >= win.from && o.dates[i] <= win.to && o.dates[i] > firstExec)).totalReturnPct;

  // ---- 069500 B&H (정제), KOSPI ----
  const etfRaw = await readEtf(SEASON_STOCK_CODE);
  const kRetByDate = new Map<string, number>();
  for (let i = 1; i < kospi.length; i++) kRetByDate.set(kospi[i].tradeDate, kospi[i].closePrice / kospi[i - 1].closePrice - 1);
  const etf = etfRaw.map((x) => ({ ...x }));
  {
    const r = etfRaw.map((x, i) => (i === 0 ? NaN : x.px / etfRaw[i - 1].px - 1));
    let nCh = 0;
    for (let t = 1; t + 1 < etfRaw.length; t++) {
      if (!(Math.abs(r[t]) > ETF_SPIKE_MIN_ABS_RET) || !(Math.sign(r[t + 1]) === -Math.sign(r[t])) || !(Math.abs((1 + r[t]) * (1 + r[t + 1]) - 1) < ETF_SPIKE_MAX_NET_ABS)) continue;
      const kr = kRetByDate.get(etfRaw[t].date);
      if (kr !== undefined && Math.sign(kr) === Math.sign(r[t]) && Math.abs(kr) >= ETF_SPIKE_KOSPI_EXEMPT_RATIO * Math.abs(r[t])) continue;
      etf[t].px = Math.sqrt(etfRaw[t - 1].px * etfRaw[t + 1].px); nCh++;
    }
    console.log(`069500 정제로 바꾼 날 ${nCh}개`);
  }
  const bh = { dates: etf.slice(1).map((x) => x.date), ret: etf.slice(1).map((x, i) => (x.px / etf[i].px - 1) * 100) };
  const kp = kospi.filter((p) => p.tradeDate >= "2009-12-01");
  const kos = { dates: kp.slice(1).map((p) => p.tradeDate), ret: computeIndexDailyReturnsPct(kp as never) };

  const LEARN: Win = { ...FLOW_TILT_LEARN }, CONFIRM: Win = { ...FLOW_TILT_CONFIRM }, HOLD: Win = { from: FLOW_TILT_HOLDOUT_FROM, to: "9999-12-31" }, FULL: Win = { from: FLOW_TILT_LEARN.from, to: "9999-12-31" };
  const gatesOf = (x: Stat, p: Stat, b: Stat, drop: number): boolean[] => [x.cagr >= p.cagr + FLOW_TILT_G1_CAGR_MARGIN_PP, x.cagr > b.cagr, x.mdd <= p.mdd + FLOW_TILT_G3_MDD_MARGIN_PP, drop <= FLOW_TILT_G4_MAX_DELAY_DROP_PP];
  const HEAD = "| 구성 | CAGR % | MDD % | 샤프 | 연변동성 % | 월평균 회전율 % | 누적 비용 % | 평균 보유 종목 수 | 지연 CAGR % | 하락 %p | G1 | G2 | G3 | G4 |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|";
  const row = (lab: string, s: Stat, extra: string): string => `| ${lab} | ${f2(s.cagr)} | ${f2(s.mdd)} | ${f2(s.sharpe)} | ${f2(s.vol)} | ${f2(s.turnover)} | ${f2(s.cost)} | ${f2(s.avgN)} | ${extra}`;
  const refRow = (lab: string, s: Stat, full: boolean): string => `| ${lab} | ${f2(s.cagr)} | ${f2(s.mdd)} | ${f2(s.sharpe)} | ${f2(s.vol)} | ${full ? `${f2(s.turnover)} | ${f2(s.cost)} | ${f2(s.avgN)}` : "- | - | -"} | | | | | | |`;

  // ---- 학습 ----
  const t60 = new Map<Kind, Map<string, number>[]>();
  for (const k of [...VARIANTS, "POOL"] as Kind[]) t60.set(k, targetsOf(k, FLOW_TILT_WINDOW_DAYS));
  const first = planAt(firstSignal, FLOW_TILT_WINDOW_DAYS);
  console.log(`첫 신호일 풀 ${first.pool.length}종목 중 강도 있는 종목 ${first.str.length}개, 수급 정리본에 없는 풀 종목 ${first.nNoFlow}개`);
  const L: Record<string, { base: Out; delay?: Out }> = {};
  for (const k of VARIANTS) L[k] = { base: run(t60.get(k)!, false, LEARN.to), delay: run(t60.get(k)!, true, LEARN.to) };
  L.POOL = { base: run(t60.get("POOL")!, false, LEARN.to) };
  const sL = new Map<string, Stat>();
  for (const k of [...VARIANTS, "POOL"] as Kind[]) sL.set(k, st(L[k].base, LEARN));
  const bhL = st(bh, LEARN), kL = st(kos, LEARN);
  const pL = sL.get("POOL")!;
  console.log(`\n=== (b) 학습 ${LEARN.from}~${LEARN.to} ===\n${HEAD}`);
  const qual = new Map<Kind, { ok: boolean; excess: number; cagr: number; turn: number }>();
  for (const k of VARIANTS) {
    const s = sL.get(k)!, sd = st(L[k].delay!, LEARN), drop = s.cagr - sd.cagr, g = gatesOf(s, pL, bhL, drop);
    qual.set(k, { ok: g.every(Boolean), excess: s.cagr - pL.cagr, cagr: s.cagr, turn: s.turnover });
    console.log(row(DESC[k], s, `${f2(sd.cagr)} | ${f2(drop)} | ${g.map(ox).join(" | ")} |`));
  }
  console.log(refRow("POOL", pL, true)); console.log(refRow("B&H(069500)", bhL, false)); console.log(refRow("KOSPI", kL, false));
  console.log(`기준: G1 CAGR ≥ POOL ${f2(pL.cagr)} + ${FLOW_TILT_G1_CAGR_MARGIN_PP} = ${f2(pL.cagr + FLOW_TILT_G1_CAGR_MARGIN_PP)}, G2 CAGR > B&H ${f2(bhL.cagr)}, G3 MDD ≤ POOL ${f2(pL.mdd)} + ${FLOW_TILT_G3_MDD_MARGIN_PP} = ${f2(pL.mdd + FLOW_TILT_G3_MDD_MARGIN_PP)}, G4 지연 하락 ≤ ${FLOW_TILT_G4_MAX_DELAY_DROP_PP}`);
  const yrsOf = (win: Win): number[] => { const a: number[] = []; for (let y = Number(win.from.slice(0, 4)); y <= Math.min(Number(win.to.slice(0, 4)), Number(dataEnd.slice(0, 4))); y++) a.push(y); return a; };
  console.log("연도별 수익률 %\n| 연도 | K1 | K2 | K3 | POOL | B&H |\n|---|---|---|---|---|---|");
  for (const y of yrsOf(LEARN)) console.log(`| ${y} | ${VARIANTS.map((k) => f2(yearRet(L[k].base, y, LEARN))).join(" | ")} | ${f2(yearRet(L.POOL.base, y, LEARN))} | ${f2(yearRet(bh, y, LEARN))} |`);

  // ---- 정보용 (학습 구간만) ----
  const rank = (v: number[]): number[] => {
    const o = v.map((x, i) => ({ x, i })).sort((a, b) => a.x - b.x);
    const r = new Array<number>(v.length);
    for (let a = 0; a < o.length;) { let b = a; while (b + 1 < o.length && o[b + 1].x === o[a].x) b++; for (let c = a; c <= b; c++) r[o[c].i] = (a + b) / 2 + 1; a = b + 1; }
    return r;
  };
  const corr = (a: number[], b: number[]): number => {
    const ma = a.reduce((s, x) => s + x, 0) / a.length, mb = b.reduce((s, x) => s + x, 0) / b.length;
    let sab = 0, saa = 0, sbb = 0;
    for (let i = 0; i < a.length; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
    return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : NaN;
  };
  const infoMonths = signals.filter((d) => { const k = monthEnds.indexOf(d); return k + 1 < monthEnds.length && monthEnds[k + 1] <= LEARN.to; });
  const infoRes = (key: "f" | "fo") => {
    const rhos: number[] = [], grp = [[], [], []] as number[][];
    for (const d of infoMonths) {
      const nd = monthEnds[monthEnds.indexOf(d) + 1];
      const items: { s: number; r: number; g: number }[] = [];
      const sorted = [...planAt(d, FLOW_TILT_WINDOW_DAYS).str].sort(desc(key));
      sorted.forEach((x, i) => {
        const i0 = x.sk.idx.get(d), i1 = x.sk.idx.get(nd);
        if (i0 === undefined || i1 === undefined) return;
        items.push({ s: x[key], r: x.sk.close[i1] / x.sk.close[i0] - 1, g: groupOf(i, sorted.length) });
      });
      if (items.length < 5) continue;
      const rho = corr(rank(items.map((p) => p.s)), rank(items.map((p) => p.r)));
      if (Number.isFinite(rho)) rhos.push(rho);
      for (let g = 0; g < 3; g++) { const v = items.filter((p) => p.g === g).map((p) => p.r); if (v.length) grp[g].push((v.reduce((a, x) => a + x, 0) / v.length) * 100); }
    }
    const m = rhos.reduce((a, x) => a + x, 0) / Math.max(rhos.length, 1);
    const sd = Math.sqrt(rhos.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(rhos.length - 1, 1));
    return { months: rhos.length, m, sd, t: m / (sd / Math.sqrt(rhos.length)), pos: (rhos.filter((x) => x > 0).length / Math.max(rhos.length, 1)) * 100, g: grp.map((a) => a.reduce((s, x) => s + x, 0) / Math.max(a.length, 1)) };
  };
  const iF = infoRes("f"), iFo = infoRes("fo");
  let sumPool = 0, sumStr = 0, sumNoFlow = 0;
  for (const d of infoMonths) { const pl = planAt(d, FLOW_TILT_WINDOW_DAYS); sumPool += pl.pool.length; sumStr += pl.str.length; sumNoFlow += pl.nNoFlow; }
  console.log(`\n=== (c) 정보용 (학습 구간만, 대상 ${infoMonths.length}개월) ===`);
  console.log("| 강도 | 상관 계산 월 수 | 스피어만 상관 월 평균 | 월 표준편차 | t값 | 양수인 달 비율 % | 상위 1/3 다음 달 평균 % | 중간 | 하위 1/3 |\n|---|---|---|---|---|---|---|---|---|");
  for (const [lab, r] of [["I_f", iF], ["I_fo", iFo]] as const) console.log(`| ${lab} | ${r.months} | ${r.m.toFixed(4)} | ${r.sd.toFixed(4)} | ${f2(r.t)} | ${f2(r.pos)} | ${r.g.map(f2).join(" | ")} |`);
  console.log(`월평균 풀 ${(sumPool / infoMonths.length).toFixed(1)}종목, 강도 있는 종목 ${(sumStr / infoMonths.length).toFixed(1)}개, 수급 정리본에 없는 풀 종목 ${(sumNoFlow / infoMonths.length).toFixed(2)}개`);

  // ---- 선택 ----
  const qualified = VARIANTS.filter((k) => qual.get(k)!.ok).sort((a, b) => qual.get(b)!.excess - qual.get(a)!.excess || qual.get(a)!.turn - qual.get(b)!.turn);
  console.log("\n=== (d) 선택 결과 ===");
  if (!qualified.length) { console.log("선택 없음 (G1~G4 전부 O인 변형 0개) — 확인 계산을 하지 않고 종료합니다."); return finish(); }
  const sel = qualified[0];
  console.log(`G1~G4 전부 O 변형 ${qualified.length}개: ${qualified.map((k) => `${k}(초과 ${f2(qual.get(k)!.excess)}%p)`).join(", ")} → 선택: ${sel}`);

  const FB = run(t60.get(sel)!, false, "9999-12-31"), FD = run(t60.get(sel)!, true, "9999-12-31"), FP = run(t60.get("POOL")!, false, "9999-12-31");
  const stage = (label: string, win: Win): boolean => {
    const s = st(FB, win), sd = st(FD, win), p = st(FP, win), b = st(bh, win), k = st(kos, win);
    const drop = s.cagr - sd.cagr, g = gatesOf(s, p, b, drop);
    console.log(`\n=== ${label} ${win.from}~${win.to > dataEnd ? dataEnd : win.to} ===\n${HEAD}`);
    console.log(row(DESC[sel], s, `${f2(sd.cagr)} | ${f2(drop)} | ${g.map(ox).join(" | ")} |`));
    console.log(refRow("POOL", p, true)); console.log(refRow("B&H(069500)", b, false)); console.log(refRow("KOSPI", k, false));
    console.log(`기준: G1 ≥ ${f2(p.cagr + FLOW_TILT_G1_CAGR_MARGIN_PP)}, G2 > ${f2(b.cagr)}, G3 ≤ ${f2(p.mdd + FLOW_TILT_G3_MDD_MARGIN_PP)}, G4 하락 ≤ ${FLOW_TILT_G4_MAX_DELAY_DROP_PP}`);
    console.log(`연도별 수익률 %\n| 연도 | ${sel} | POOL | B&H |\n|---|---|---|---|`);
    for (const y of yrsOf(win)) console.log(`| ${y} | ${f2(yearRet(FB, y, win))} | ${f2(yearRet(FP, y, win))} | ${f2(yearRet(bh, y, win))} |`);
    return g.every(Boolean);
  };
  if (!stage("(e) 확인", CONFIRM)) { console.log("\n확인 결과: 통과 아님 (홀드아웃 계산하지 않음)"); return finish(); }
  if (!stage("(e) 홀드아웃", HOLD)) { console.log("\n홀드아웃 결과: 통과 아님 (R1~R3 계산하지 않음)"); return finish(); }

  // ---- 추가 검증 R1~R3 ----
  const fullS = st(FB, FULL), fullP = st(FP, FULL);
  console.log(`\n=== (f) 추가 검증 R1~R3 (전 기간 ${FULL.from}~${dataEnd}; 전략 CAGR ${f2(fullS.cagr)}, POOL CAGR ${f2(fullP.cagr)}, 기준 ${f2(fullP.cagr + FLOW_TILT_R_CAGR_MARGIN_PP)}) ===`);
  const r1 = FLOW_TILT_R1_WINDOW_DAYS.map((n) => { const s = st(run(targetsOf(sel, n), false, "9999-12-31"), FULL); return { n, cagr: s.cagr, ok: s.cagr >= fullP.cagr + FLOW_TILT_R_CAGR_MARGIN_PP }; });
  console.log("R1\n| 창(거래일) | 전 기간 CAGR % | O/X |\n|---|---|---|");
  for (const x of r1) console.log(`| ${x.n} | ${f2(x.cagr)} | ${ox(x.ok)} |`);
  const r1ok = r1.every((x) => x.ok);
  // R2
  const mo = new Map<string, { s: number[]; p: number[]; idx: number[] }>();
  FB.dates.forEach((d, i) => { if (d < FULL.from || d <= firstExec) return; const m = d.slice(0, 7); const e = mo.get(m) ?? { s: [], p: [], idx: [] }; e.s.push(FB.ret[i]); e.p.push(FP.ret[i]); e.idx.push(i); mo.set(m, e); });
  const mret = (a: number[]): number => computeCumulativeAndMdd(a).totalReturnPct;
  let best = { m: "", ex: -Infinity };
  for (const [m, e] of mo) { const ex = mret(e.s) - mret(e.p); if (ex > best.ex) best = { m, ex }; }
  const repl = [...FB.ret];
  for (const i of mo.get(best.m)!.idx) repl[i] = FP.ret[i];
  const r2s = st(FB, FULL, repl), r2ok = r2s.cagr >= fullP.cagr + FLOW_TILT_R_CAGR_MARGIN_PP;
  console.log(`R2: POOL 대비 월 초과 수익 최대 ${best.m} (${f2(best.ex)}%p) 를 POOL 수익으로 바꾼 전 기간 CAGR ${f2(r2s.cagr)} vs 기준 ${f2(fullP.cagr + FLOW_TILT_R_CAGR_MARGIN_PP)} → ${ox(r2ok)}`);
  // R3
  const rng = mulberry32(FLOW_TILT_R3_SEED);
  let ge = 0;
  const pl60 = signals.map((d) => planAt(d, FLOW_TILT_WINDOW_DAYS));
  const draws: number[] = [];
  for (let n = 0; n < FLOW_TILT_R3_DRAWS; n++) {
    const tg = pl60.map((pl) => targetFor(sel, pl, (s) => { const a = [...s]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }));
    const c = st(run(tg, false, "9999-12-31"), FULL).cagr;
    draws.push(c);
    if (c >= fullS.cagr) ge++;
  }
  draws.sort((a, b) => a - b);
  const r3p = ge / FLOW_TILT_R3_DRAWS, r3ok = r3p <= FLOW_TILT_R3_TOP_FRACTION;
  console.log(`R3: 무작위 ${FLOW_TILT_R3_DRAWS}회 전 기간 CAGR 중앙값 ${f2(draws[Math.floor(draws.length / 2)])}, 95분위 ${f2(draws[Math.floor(draws.length * 0.95)])}, 최대 ${f2(draws[draws.length - 1])}; 전략 ${f2(fullS.cagr)} 이상인 횟수 ${ge} (${f2(r3p * 100)}%) → ${ox(r3ok)} (기준 상위 ${FLOW_TILT_R3_TOP_FRACTION * 100}% 이내)`);
  console.log(`\n최종: ${r1ok && r2ok && r3ok ? "통과" : "통과 아님"} (R1 ${ox(r1ok)} R2 ${ox(r2ok)} R3 ${ox(r3ok)})`);
  finish();

  function finish(): void {
    console.log("\n=== (g) 실행 지표 ===");
    console.log(`Supabase 읽은 행: ${Object.entries(dbRead).map(([k, v]) => `${k} ${v}`).join(" | ")} | 합계 ${Object.values(dbRead).reduce((a, b) => a + b, 0)}`);
    console.log(`Storage 다운로드(수급 정리본): ${flowRows}행, ${flowBytes} B (${(flowBytes / 1048576).toFixed(2)} MiB) | Supabase 쓴 행: 0 | 외부 요청 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });
