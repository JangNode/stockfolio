/**
 * [임시 연구 — 병합 금지, 읽기 전용, 외부 요청 0건] 분기 실적 틸트 전략 4변형 (T94~97).
 * 사전 등록: research/quarterly-tilt-prereg.md (커밋 bec9a35). 정의·선택 규칙은 그 문서가 고정한다. 숫자와 표, O/X만 출력한다.
 */
import { getIndexPriceSeries } from "@/lib/betaPriceHistoryStorage";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadAllStockSeriesFromParquet } from "@/lib/stockDailyPricesStorage";
import { loadAppliedAdjustments } from "@/lib/stockPriceAdjustmentsStorage";
import { computeTrailingAvgTradingValue } from "@/lib/pitUniverse";
import { PIT_LIQUIDITY_LOOKBACK_DAYS, PIT_MIN_AVG_TRADING_VALUE_WON, STOCK_DATA_EARLIEST_YEAR } from "@/lib/strategyBacktestSummaryConfig";
import { computeCumulativeAndMdd, computeCagrPct } from "@/lib/strategyBacktestSummary";
import { computeIndexDailyReturnsPct } from "@/lib/benchmarkSummary";
import { computeEffectiveBuyPrice, computeEffectiveSellPrice } from "@/lib/transactionCost";

const T0 = Date.now();
const TODAY = new Date().toISOString().slice(0, 10);
const CAP_EOK = 5000;
const POOL_SIZE = 100;
const WIN_START = "2016-06-01", LEARN_END = "2020-12-31", CONFIRM_START = "2021-01-01";
const FIRST_REBAL_MONTH = "2016-05";
const FRESH_DAYS = 150;
const TILT_UP = 2, TILT_DOWN = 0.5, W_CAP = 0.2, FULL_N = 5;
const QUAL_MDD_MARGIN = 3.0, C3_MARGIN = 3.0, C5_MAX_DROP = 1.0;
const SEASON_MONTHS = [5, 8, 11];
const ENDED_GRACE_DAYS = 14;
const EOK = 1e8;
const MS_DAY = 86_400_000;
const QEND: Record<number, string> = { 1: "03-31", 2: "06-30", 3: "09-30" };
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

interface Sk { code: string; dates: string[]; close: Float64Array; mcap: Float64Array; avgTv: Float64Array; idx: Map<string, number>; last: string }
interface Rec { rcept: string; order: number; opD: number | null; niD: number | null }
interface Out { dates: string[]; ret: number[]; costFrac: number[]; turn: { d: string; v: number }[]; contrib: Map<string, number>[] }
interface Win { from: string; to: string }
type Kind = "Q1" | "Q2" | "Q3" | "Q4" | "POOL" | "D4";
const VARIANTS: Kind[] = ["Q1", "Q2", "Q3", "Q4"];
const DESC: Record<Kind, string> = { Q1: "Q1 S_OP 틸트 월말", Q2: "Q2 S_NI 틸트 월말", Q3: "Q3 S_OP 틸트 실적시즌(5·8·11월)", Q4: "Q4 S_OP 선정형 월말", POOL: "POOL", D4: "D4" };

async function main(): Promise<void> {
  console.log(`분기 실적 틸트 4변형(T94~97) 시작(읽기 전용): ${new Date().toISOString()} (사전등록 bec9a35 이후)`);
  const adjustments = await loadAppliedAdjustments();
  dbRead["stock_price_adjustment_events(applied)"] = [...adjustments.values()].reduce((a, l) => a + l.length, 0);
  const series = await loadAllStockSeriesFromParquet(Math.max(STOCK_DATA_EARLIEST_YEAR, 2015), new Date().getUTCFullYear(), adjustments);
  const kospi = await getIndexPriceSeries("KOSPI", "2015-01-01", TODAY);
  dbRead["beta_price_history(KOSPI)"] = kospi.length;

  const stocks: Sk[] = [];
  const calSet = new Set<string>();
  for (const [code, rows] of series) {
    for (const r of rows) if (r.tradeDate >= `${FIRST_REBAL_MONTH}-01`) calSet.add(r.tradeDate);
    stocks.push({ code, dates: rows.map((r) => r.tradeDate), close: Float64Array.from(rows.map((r) => r.closePrice)), mcap: Float64Array.from(rows.map((r) => r.marketCapEok)), avgTv: computeTrailingAvgTradingValue(rows, PIT_LIQUIDITY_LOOKBACK_DAYS), idx: new Map(rows.map((r, i) => [r.tradeDate, i])), last: rows[rows.length - 1].tradeDate });
    series.delete(code);
  }
  stocks.sort((a, b) => (a.code < b.code ? -1 : 1));
  const byCode = new Map(stocks.map((s) => [s.code, s]));
  const CALF = [...calSet].sort();
  const dataEnd = CALF[CALF.length - 1];
  const monthEnds: string[] = [];
  for (let k = 0; k + 1 < CALF.length; k++) if (CALF[k].slice(0, 7) !== CALF[k + 1].slice(0, 7)) monthEnds.push(CALF[k]);
  const endedBefore = new Date(Date.parse(dataEnd) - ENDED_GRACE_DAYS * MS_DAY).toISOString().slice(0, 10);
  console.log(`종목 ${stocks.length}개, 거래일(2016-05~) ${CALF.length}일 ${CALF[0]}~${dataEnd}, 월말 ${monthEnds.length}개`);

  // ---- 분기 레코드 구성 ----
  interface QRowDb { corp_code: string; stock_code: string; fiscal_year: number; quarter: number; fs_div: string | null; rcept_date: string | null; ni_parent_q: number | null; ni_parent_cum: number | null; ni_parent_prev_q: number | null; ni_parent_prev_cum: number | null; op_income_q: number | null; op_income_prev_q: number | null; off_cycle: boolean }
  const q = await selectAll<QRowDb>("dart_quarterly_fundamentals(ok)", (f, t) => supabaseAdmin.from("dart_quarterly_fundamentals").select("corp_code, stock_code, fiscal_year, quarter, fs_div, rcept_date, ni_parent_q, ni_parent_cum, ni_parent_prev_q, ni_parent_prev_cum, op_income_q, op_income_prev_q, off_cycle").eq("status", "ok").order("corp_code").order("fiscal_year").order("quarter").range(f, t));
  interface AnnDb { stock_code: string; fiscal_year: number; rcept_date: string | null; net_income_parent: number | null; fs_div: string }
  const ann = await selectAll<AnnDb>("stock_annual_fundamentals", (f, t) => supabaseAdmin.from("stock_annual_fundamentals").select("stock_code, fiscal_year, rcept_date, net_income_parent, fs_div").order("stock_code").order("fiscal_year").range(f, t));
  const annBy = new Map(ann.map((a) => [`${a.stock_code}|${a.fiscal_year}`, a]));
  const recsBy = new Map<string, Rec[]>();
  const excl = { total: q.length, offCycle: 0, rceptNull: 0, rceptBeforeQEnd: 0, used: 0 };
  const validQ = new Map<string, QRowDb>();
  for (const r of q) {
    if (r.off_cycle) { excl.offCycle++; continue; }
    if (!r.rcept_date) { excl.rceptNull++; continue; }
    if (r.rcept_date < `${r.fiscal_year}-${QEND[r.quarter]}`) { excl.rceptBeforeQEnd++; continue; }
    excl.used++;
    validQ.set(`${r.stock_code}|${r.fiscal_year}|${r.quarter}`, r);
    const opD = r.op_income_q !== null && r.op_income_prev_q !== null ? Number(r.op_income_q) - Number(r.op_income_prev_q) : null;
    const niD = r.ni_parent_q !== null && r.ni_parent_prev_q !== null ? Number(r.ni_parent_q) - Number(r.ni_parent_prev_q) : null;
    (recsBy.get(r.stock_code) ?? recsBy.set(r.stock_code, []).get(r.stock_code)!).push({ rcept: r.rcept_date, order: r.fiscal_year * 10 + r.quarter, opD, niD });
  }
  const q4 = { attempts: 0, ok: 0, noQ3: 0, nullVal: 0, fsMismatch: 0, rceptInverted: 0 };
  for (const a of ann) {
    if (a.fiscal_year < 2016 || a.fiscal_year > 2026) continue;
    q4.attempts++;
    const q3 = validQ.get(`${a.stock_code}|${a.fiscal_year}|3`);
    if (!q3) { q4.noQ3++; continue; }
    const a1 = annBy.get(`${a.stock_code}|${a.fiscal_year - 1}`);
    if (!a.rcept_date || a.net_income_parent === null || !a1 || a1.net_income_parent === null || q3.ni_parent_cum === null || q3.ni_parent_prev_cum === null) { q4.nullVal++; continue; }
    if (!(a.fs_div === q3.fs_div && a1.fs_div === q3.fs_div)) { q4.fsMismatch++; continue; }
    if (a.rcept_date < (q3.rcept_date as string)) { q4.rceptInverted++; continue; }
    const niD = (Number(a.net_income_parent) - Number(q3.ni_parent_cum)) - (Number(a1.net_income_parent) - Number(q3.ni_parent_prev_cum));
    q4.ok++;
    (recsBy.get(a.stock_code) ?? recsBy.set(a.stock_code, []).get(a.stock_code)!).push({ rcept: a.rcept_date, order: a.fiscal_year * 10 + 4, opD: null, niD });
  }
  for (const l of recsBy.values()) l.sort((x, y) => (x.rcept < y.rcept ? -1 : x.rcept > y.rcept ? 1 : x.order - y.order));
  /** 기준일 t의 신호 분자(당기−전기): 가장 최근 분기(rcept ≤ t)가 150일 이내일 때만. */
  function numer(code: string, t: string): { op: number | null; ni: number | null } {
    const l = recsBy.get(code);
    if (!l) return { op: null, ni: null };
    let rec: Rec | null = null;
    for (const r of l) { if (r.rcept <= t) rec = r; else break; }
    if (!rec || dayDiff(rec.rcept, t) > FRESH_DAYS) return { op: null, ni: null };
    return { op: rec.opD, ni: rec.niD };
  }

  // ---- 풀·목표 비중 ----
  interface El { sk: Sk; i: number; mcap: number }
  const eligibleAt = (d: string): El[] => {
    const el: El[] = [];
    for (const sk of stocks) {
      const i = sk.idx.get(d);
      if (i === undefined || i < 1 || !(sk.mcap[i - 1] >= CAP_EOK) || !(sk.avgTv[i] >= PIT_MIN_AVG_TRADING_VALUE_WON)) continue;
      el.push({ sk, i, mcap: sk.mcap[i] });
    }
    return el;
  };
  const byMcap = (a: El, b: El): number => b.mcap - a.mcap || (a.sk.code < b.sk.code ? -1 : 1);
  const poolAt = (d: string): El[] => eligibleAt(d).sort(byMcap).slice(0, POOL_SIZE);
  const capWeights = (items: { code: string; m: number }[], total: number): Map<string, number> => {
    const out = new Map<string, number>();
    let remaining = total, active = [...items];
    for (;;) {
      const sumM = active.reduce((a, x) => a + x.m, 0);
      const over = active.filter((x) => (remaining * x.m) / sumM > W_CAP + 1e-12);
      if (!over.length) { for (const x of active) out.set(x.code, (remaining * x.m) / sumM); return out; }
      for (const x of over) { out.set(x.code, W_CAP); remaining -= W_CAP; }
      active = active.filter((x) => !over.includes(x));
      if (!active.length) return out;
    }
  };
  /** 풀 종목별 신호 S = 분자 ÷ (당일 시총 × 1e8). */
  function signals(pool: El[], d: string, which: "op" | "ni"): { code: string; s: number }[] {
    const out: { code: string; s: number }[] = [];
    for (const x of pool) {
      const n = numer(x.sk.code, d);
      const v = which === "op" ? n.op : n.ni;
      if (v === null || !(x.mcap > 0)) continue;
      out.push({ code: x.sk.code, s: v / (x.mcap * EOK) });
    }
    out.sort((a, b) => b.s - a.s || (a.code < b.code ? -1 : 1));
    return out;
  }
  function targetFor(kind: Kind, d: string): Map<string, number> {
    if (kind === "D4") { const el = eligibleAt(d); const t = el.reduce((a, x) => a + x.mcap, 0); return new Map(el.map((x) => [x.sk.code, x.mcap / t])); }
    const pool = poolAt(d);
    if (kind === "POOL") { const t = pool.reduce((a, x) => a + x.mcap, 0); return new Map(pool.map((x) => [x.sk.code, x.mcap / t])); }
    const which = kind === "Q2" ? "ni" : "op";
    const sg = signals(pool, d, which);
    const k = Math.floor(sg.length / 5);
    if (kind === "Q4") {
      if (k === 0) return new Map();
      const mc = new Map(pool.map((x) => [x.sk.code, x.mcap]));
      const sel = sg.slice(0, k).map((x) => ({ code: x.code, m: mc.get(x.code)! }));
      return capWeights(sel, sel.length >= FULL_N ? 1 : sel.length * W_CAP);
    }
    const mult = new Map<string, number>();
    if (k > 0) { for (const x of sg.slice(0, k)) mult.set(x.code, TILT_UP); for (const x of sg.slice(sg.length - k)) mult.set(x.code, TILT_DOWN); }
    const den = pool.reduce((a, x) => a + x.mcap * (mult.get(x.sk.code) ?? 1), 0);
    return new Map(pool.map((x) => [x.sk.code, (x.mcap * (mult.get(x.sk.code) ?? 1)) / den]));
  }

  // ---- 엔진 ----
  const buyRate = computeEffectiveBuyPrice(1) - 1;
  const firstRebal = monthEnds.find((d) => d.slice(0, 7) === FIRST_REBAL_MONTH)!;
  const rebalSet = (kind: Kind): Set<string> => new Set(monthEnds.filter((d) => d >= firstRebal && (kind !== "Q3" || SEASON_MONTHS.includes(Number(d.slice(5, 7))))));
  function run(kind: Kind, delay: boolean, endD: string): Out {
    const rs = rebalSet(kind);
    let cash = 1, prevV = 1;
    const pos = new Map<string, { val: number; last: number }>();
    const out: Out = { dates: [], ret: [], costFrac: [], turn: [], contrib: [] };
    let pending: Map<string, number> | null = null;
    for (const d of CALF) {
      if (d < firstRebal) continue;
      if (d > endD) break;
      const sellRate = 1 - computeEffectiveSellPrice(1, d, "KR");
      let costF = 0;
      const dayContrib = new Map<string, number>();
      for (const [code, p] of [...pos.entries()]) {
        const sk = byCode.get(code)!;
        const i = sk.idx.get(d);
        if (i !== undefined) { const nv = (p.val * sk.close[i]) / p.last; dayContrib.set(code, (nv - p.val) / prevV); p.val = nv; p.last = sk.close[i]; }
        else if (sk.last < d && sk.last < endedBefore) { costF += (p.val * sellRate) / prevV; cash += p.val * (1 - sellRate); pos.delete(code); }
      }
      let now: Map<string, number> | null = null;
      if (delay) { if (pending) { now = pending; pending = null; } if (rs.has(d)) pending = targetFor(kind, d); }
      else if (rs.has(d)) now = targetFor(kind, d);
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
        for (const [code, w] of tg) { const sk = byCode.get(code)!; const val = w * V * scale; pos.set(code, { val, last: sk.close[sk.idx.get(d)!] }); inv += val; }
        cash = V - C - inv;
        costF += V > 0 ? C / V : 0;
        if (buyN + sellN > 0) out.turn.push({ d, v: V > 0 ? (buyN + sellN) / 2 / V : 0 });
      }
      const V = cash + [...pos.values()].reduce((a, p) => a + p.val, 0);
      out.dates.push(d); out.ret.push((V / prevV - 1) * 100); out.costFrac.push(costF); out.contrib.push(dayContrib);
      prevV = V;
    }
    return out;
  }

  // ---- 지표 ----
  const endCap = (e: string): string => (e > TODAY ? TODAY : e);
  function st(dates: string[], rets: number[], win: Win, costFrac?: number[], turn?: { d: string; v: number }[]) {
    const idx: number[] = [];
    for (let i = 0; i < dates.length; i++) if (dates[i] >= win.from && dates[i] <= win.to) idx.push(i);
    const r = idx.map((i) => rets[i]);
    const { totalReturnPct, mddPct } = computeCumulativeAndMdd(r);
    const cagr = computeCagrPct(totalReturnPct, win.from, endCap(win.to));
    const m = r.reduce((a, x) => a + x, 0) / Math.max(r.length, 1);
    const sd = Math.sqrt(r.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(r.length - 1, 1));
    const yrs = Math.max(dayDiff(win.from, endCap(win.to)) / 365.25, 1e-9);
    return {
      cagr, mdd: mddPct, cm: mddPct > 0 ? cagr / mddPct : NaN, vol: sd * Math.sqrt(252),
      cost: costFrac ? idx.reduce((a, i) => a + costFrac[i], 0) * 100 : NaN,
      turnover: turn ? (turn.filter((x) => x.d >= win.from && x.d <= win.to).reduce((a, x) => a + x.v, 0) / yrs) * 100 : NaN,
    };
  }
  const LEARN: Win = { from: WIN_START, to: LEARN_END }, CONFIRM: Win = { from: CONFIRM_START, to: "9999-12-31" }, FULL: Win = { from: WIN_START, to: "9999-12-31" };
  const seriesYear = (dates: string[], rets: number[], y: number): number => computeCumulativeAndMdd(rets.filter((_, i) => dates[i].startsWith(`${y}-`))).totalReturnPct;
  const kp = kospi.filter((p) => p.tradeDate >= "2016-05-01");
  const kRets = computeIndexDailyReturnsPct(kp as never);
  const kDates = kp.slice(1).map((p) => p.tradeDate);

  // ---- 학습: 4변형 + POOL + D4 (2020-12-31까지만) ----
  const learnRuns = new Map<Kind, Out>();
  for (const k of [...VARIANTS, "POOL", "D4"] as Kind[]) learnRuns.set(k, run(k, false, LEARN_END));
  const LS = new Map<string, ReturnType<typeof st>>();
  for (const k of [...VARIANTS, "POOL", "D4"] as Kind[]) { const o = learnRuns.get(k)!; LS.set(k, st(o.dates, o.ret, LEARN, o.costFrac, o.turn)); }
  LS.set("KOSPI", st(kDates, kRets, LEARN));
  const pL = LS.get("POOL")!, dL = LS.get("D4")!;
  const qual = new Map<Kind, boolean>();
  for (const k of VARIANTS) { const s = LS.get(k)!; qual.set(k, s.cagr > pL.cagr && s.cagr > dL.cagr && s.mdd <= pL.mdd + QUAL_MDD_MARGIN); }

  console.log("\n=== (b) 학습 구간(2016-06-01~2020-12-31) 4변형 ===");
  console.log("| 구성 | CAGR % | MDD % | CAGR÷MDD | 연변동성 % | 연 회전율 % | 누적 비용 % | 자격 |\n|---|---|---|---|---|---|---|---|");
  for (const k of VARIANTS) { const s = LS.get(k)!; console.log(`| ${DESC[k]} | ${f2(s.cagr)} | ${f2(s.mdd)} | ${f2(s.cm)} | ${f2(s.vol)} | ${f2(s.turnover)} | ${f2(s.cost)} | ${ox(qual.get(k)!)} |`); }
  for (const k of ["POOL", "D4"] as Kind[]) { const s = LS.get(k)!; console.log(`| ${k} | ${f2(s.cagr)} | ${f2(s.mdd)} | ${f2(s.cm)} | ${f2(s.vol)} | ${f2(s.turnover)} | ${f2(s.cost)} | - |`); }
  { const s = LS.get("KOSPI")!; console.log(`| KOSPI | ${f2(s.cagr)} | ${f2(s.mdd)} | ${f2(s.cm)} | ${f2(s.vol)} | - | - | - |`); }
  console.log(`자격 기준: 학습 CAGR > POOL ${f2(pL.cagr)} 그리고 > D4 ${f2(dL.cagr)}, 학습 MDD ≤ POOL ${f2(pL.mdd)} + ${QUAL_MDD_MARGIN} = ${f2(pL.mdd + QUAL_MDD_MARGIN)}`);

  // ---- 정보용(학습 구간만) ----
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
  const infoMonths = monthEnds.filter((d, k) => d >= firstRebal && k + 1 < monthEnds.length && monthEnds[k + 1] <= LEARN_END);
  const nextOf = (d: string): string => monthEnds[monthEnds.indexOf(d) + 1];
  const infoRes = (which: "op" | "ni") => {
    const rhos: number[] = [], cover: number[] = [], nSig: number[] = [], poolN: number[] = [];
    const qSum = [0, 0, 0, 0, 0], qCnt = [0, 0, 0, 0, 0];
    for (const d of infoMonths) {
      const pool = poolAt(d);
      const sg = signals(pool, d, which);
      poolN.push(pool.length); nSig.push(sg.length); cover.push(pool.length ? sg.length / pool.length : 0);
      const nd = nextOf(d);
      const pairs: { s: number; r: number }[] = [];
      for (const x of sg) {
        const sk = byCode.get(x.code)!;
        const i0 = sk.idx.get(d), i1 = sk.idx.get(nd);
        if (i0 === undefined || i1 === undefined) continue;
        pairs.push({ s: x.s, r: sk.close[i1] / sk.close[i0] - 1 });
      }
      if (pairs.length < 5) continue;
      const rho = corr(rank(pairs.map((p) => p.s)), rank(pairs.map((p) => p.r)));
      if (Number.isFinite(rho)) rhos.push(rho);
      const n = sg.length;
      const bucket: number[][] = [[], [], [], [], []];
      sg.forEach((x, i) => {
        const sk = byCode.get(x.code)!;
        const i0 = sk.idx.get(d), i1 = sk.idx.get(nd);
        if (i0 === undefined || i1 === undefined) return;
        bucket[Math.floor((i * 5) / n)].push(sk.close[i1] / sk.close[i0] - 1);
      });
      bucket.forEach((b, j) => { if (b.length) { qSum[j] += b.reduce((a, x) => a + x, 0) / b.length; qCnt[j]++; } });
    }
    const m = rhos.reduce((a, x) => a + x, 0) / Math.max(rhos.length, 1);
    const sd = Math.sqrt(rhos.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(rhos.length - 1, 1));
    return { m, t: m / (sd / Math.sqrt(rhos.length)), months: rhos.length, cover: cover.reduce((a, x) => a + x, 0) / Math.max(cover.length, 1), nSig: nSig.reduce((a, x) => a + x, 0) / Math.max(nSig.length, 1), poolN: poolN.reduce((a, x) => a + x, 0) / Math.max(poolN.length, 1), q: qSum.map((s, j) => (qCnt[j] ? (s / qCnt[j]) * 100 : NaN)) };
  };
  const infoOp = infoRes("op"), infoNi = infoRes("ni");

  // ---- 선택 ----
  const qualified = VARIANTS.filter((k) => qual.get(k)!).sort((a, b) => LS.get(b)!.cm - LS.get(a)!.cm || LS.get(a)!.turnover - LS.get(b)!.turnover);
  console.log("\n=== (c) 선택 결과 ===");
  let selected: Kind | null = null;
  if (!qualified.length) console.log("선택 없음 (자격 있는 변형 0개) — 확인 계산을 하지 않고 종료합니다.");
  else { selected = qualified[0]; console.log(`자격 있는 변형 ${qualified.length}개: ${qualified.map((k) => `${k}(${f2(LS.get(k)!.cm)})`).join(", ")} → 선택: ${selected}`); }

  if (selected) {
    const full = run(selected, false, "9999-12-31");
    const dly = run(selected, true, "9999-12-31");
    const poolF = run("POOL", false, "9999-12-31");
    const d4F = run("D4", false, "9999-12-31");
    const srcs: [string, string[], number[], number[] | undefined, { d: string; v: number }[] | undefined][] = [[`선택(${selected})`, full.dates, full.ret, full.costFrac, full.turn], ["POOL", poolF.dates, poolF.ret, poolF.costFrac, poolF.turn], ["D4", d4F.dates, d4F.ret, d4F.costFrac, d4F.turn], ["KOSPI", kDates, kRets, undefined, undefined]];
    console.log("\n=== (d) 선택 변형의 확인·전체 표 ===");
    console.log("| 구간 | 구성 | CAGR % | MDD % | CAGR÷MDD | 연변동성 % | 연 회전율 % | 누적 비용 % |\n|---|---|---|---|---|---|---|---|");
    const S: Record<string, Record<string, ReturnType<typeof st>>> = { 확인: {}, 전체: {} };
    for (const [wn, win] of [["확인", CONFIRM], ["전체", FULL]] as [string, Win][]) for (const [lab, dd, rr, cc, tt] of srcs) {
      const s = st(dd, rr, win, cc, tt); S[wn][lab.startsWith("선택") ? "SEL" : lab] = s;
      console.log(`| ${wn} | ${lab} | ${f2(s.cagr)} | ${f2(s.mdd)} | ${f2(s.cm)} | ${f2(s.vol)} | ${f2(s.turnover)} | ${f2(s.cost)} |`);
    }
    const a = S.확인.SEL, p = S.확인.POOL, d = S.확인.D4;
    const dC = st(dly.dates, dly.ret, CONFIRM, dly.costFrac);
    const drop = a.cagr - dC.cagr;
    const crit: [string, string, boolean][] = [
      ["C1 CAGR > POOL", `${f2(a.cagr)} vs ${f2(p.cagr)}`, a.cagr > p.cagr],
      ["C2 CAGR > D4", `${f2(a.cagr)} vs ${f2(d.cagr)}`, a.cagr > d.cagr],
      ["C3 MDD ≤ POOL MDD + 3.0%p", `${f2(a.mdd)} vs ${f2(p.mdd + C3_MARGIN)}`, a.mdd <= p.mdd + C3_MARGIN],
      ["C4 CAGR÷MDD > POOL", `${f2(a.cm)} vs ${f2(p.cm)}`, a.cm > p.cm],
      ["C5 지연 시 CAGR 하락 ≤ 1.0%p", `기본 ${f2(a.cagr)} → 지연 ${f2(dC.cagr)} (하락 ${f2(drop)}%p)`, drop <= C5_MAX_DROP],
    ];
    console.log("\n확인 판정:\n| 기준 | 수치 | O/X |\n|---|---|---|");
    for (const [n, v, ok] of crit) console.log(`| ${n} | ${v} | ${ox(ok)} |`);
    console.log(`확인 통과 표시: ${crit.every((c) => c[2]) ? "통과(전부 O)" : "통과 아님"}`);
    console.log(`지연 변형(+1거래일) 확인: CAGR ${f2(dC.cagr)} / MDD ${f2(dC.mdd)} / CAGR÷MDD ${f2(dC.cm)} / 연변동성 ${f2(dC.vol)} / 누적 비용 ${f2(dC.cost)}`);

    const years: number[] = [];
    for (let y = 2016; y <= new Date().getUTCFullYear(); y++) years.push(y);
    console.log("\n연도별 수익률 % (2016은 6월부터)");
    console.log("| 구성 | " + years.join(" | ") + " |\n|---|" + years.map(() => "---").join("|") + "|");
    for (const [lab, dd, rr] of srcs) console.log(`| ${lab} | ${years.map((y) => f2(seriesYear(dd, rr, y))).join(" | ")} |`);

    const tot = new Map<string, number>();
    for (let i = 0; i < full.dates.length; i++) if (full.dates[i] >= WIN_START) for (const [c, v] of full.contrib[i]) tot.set(c, (tot.get(c) ?? 0) + v);
    const top5 = [...tot.entries()].sort((x, y) => y[1] - x[1]).slice(0, 5);
    const exRet = full.ret.map((r, i) => r - [...top5].reduce((acc, [c]) => acc + (full.contrib[i].get(c) ?? 0) * 100, 0));
    const sx = st(full.dates, exRet, FULL);
    console.log("\n기여 상위 5종목(전체 구간, 일별 기여 합 %p):");
    console.log("| 종목 | 기여 합 %p |\n|---|---|");
    for (const [c, v] of top5) console.log(`| ${c} | ${f2(v * 100)} |`);
    console.log(`상위 5종목 제외 시 전체 구간 CAGR ${f2(sx.cagr)} (제외 전 ${f2(S.전체.SEL.cagr)})`);
  }

  console.log("\n=== (e) 정보용 지표 (학습 구간만) ===");
  console.log(`대상 월(월말 d, 다음 월말 ≤ ${LEARN_END}): ${infoMonths.length}개월`);
  console.log("| 신호 | 상관 계산 월 수 | 스피어만 상관 월 평균 | t값 | 신호 있는 종목 비율(월평균 %) | 신호 있는 종목 수(월평균) | 풀 크기(월평균) | 분위1(상위) 다음 달 평균 % | 분위2 | 분위3 | 분위4 | 분위5(하위) |\n|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const [lab, r] of [["S_OP", infoOp], ["S_NI", infoNi]] as const) console.log(`| ${lab} | ${r.months} | ${r.m.toFixed(4)} | ${f2(r.t)} | ${f2(r.cover * 100)} | ${r.nSig.toFixed(1)} | ${r.poolN.toFixed(1)} | ${r.q.map(f2).join(" | ")} |`);

  console.log("\n=== (f) 데이터 규칙 적용 결과 ===");
  console.log("| 항목 | 건수 |\n|---|---|");
  console.log(`| status='ok' 분기 행(FY2016~2026) | ${excl.total} |`);
  console.log(`| 제외: off_cycle=true | ${excl.offCycle} |`);
  console.log(`| 제외: rcept_date < 분기 말 | ${excl.rceptBeforeQEnd} |`);
  console.log(`| 제외: rcept_date 없음 | ${excl.rceptNull} |`);
  console.log(`| 사용 가능한 1~3분기 행 | ${excl.used} |`);
  console.log(`| 4분기 파생 시도(연간 행 FY2016~2026) | ${q4.attempts} |`);
  console.log(`| 4분기 파생 성공 | ${q4.ok} |`);
  console.log(`| 실패: 3분기 행 없음·제외 | ${q4.noQ3} |`);
  console.log(`| 실패: 필요 값 null | ${q4.nullVal} |`);
  console.log(`| 실패: fs_div 불일치 | ${q4.fsMismatch} |`);
  console.log(`| 실패: 사용 가능일 역전 | ${q4.rceptInverted} |`);
  console.log(`월평균 신호 보유 종목 수(학습 구간 매월 말 풀 기준): S_OP ${infoOp.nSig.toFixed(1)} / 풀 ${infoOp.poolN.toFixed(1)}, S_NI ${infoNi.nSig.toFixed(1)} / 풀 ${infoNi.poolN.toFixed(1)}`);

  console.log("\n=== (g) 실행 지표 ===");
  console.log(`Supabase 읽은 행: ${Object.entries(dbRead).map(([k, v]) => `${k} ${v}`).join(" | ")} | 합계 ${Object.values(dbRead).reduce((a, b) => a + b, 0)}`);
  console.log(`Supabase 쓴 행: 0 | 외부 요청(DART/KIS 등): 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
