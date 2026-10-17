/**
 * [임시 진단 — 병합 금지, 읽기 전용, 외부 요청 0건, 새 시도 아님] Q3 결과 분해 진단. Q3 규칙·데이터 규칙은 research/quarterly-tilt-prereg.md(bec9a35) 그대로. 숫자와 표만 출력한다.
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
  console.log(`Q3 결과 분해 진단 시작(읽기 전용, 새 시도 아님): ${new Date().toISOString()} (규칙: 사전등록 bec9a35)`);
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
  let excludeSet = new Set<string>();
  const eligibleAt = (d: string): El[] => {
    const el: El[] = [];
    for (const sk of stocks) {
      if (excludeSet.has(sk.code)) continue;
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


  // ---- 진단 ----
  const EX = new Set(["005930", "005935", "000660"]);
  const q3 = run("Q3", false, "9999-12-31");
  const pool = run("POOL", false, "9999-12-31");
  const d4 = run("D4", false, "9999-12-31");
  excludeSet = EX;
  const q3x = run("Q3", false, "9999-12-31");
  const poolx = run("POOL", false, "9999-12-31");
  excludeSet = new Set();
  const W3: [string, Win][] = [["학습", LEARN], ["확인", CONFIRM], ["전체", FULL]];
  { const a = st(q3.dates, q3.ret, LEARN), b = st(q3.dates, q3.ret, CONFIRM); console.log(`재현 확인(Q3 기본): 학습 CAGR ${f2(a.cagr)} / MDD ${f2(a.mdd)} (이전 10.89 / 43.74), 확인 CAGR ${f2(b.cagr)} / MDD ${f2(b.mdd)} (이전 17.52 / 43.47)`); }

  console.log("\n=== 1. 연도별 수익률과 초과수익 (%, %p; 2016은 6월부터, 2016~2020 학습·2021~ 확인) ===");
  console.log("| 연도 | 구간 | Q3 | POOL | D4 | Q3 − POOL | Q3 − D4 |\n|---|---|---|---|---|---|---|");
  const years: number[] = [];
  for (let y = 2016; y <= new Date().getUTCFullYear(); y++) years.push(y);
  for (const y of years) {
    const a = seriesYear(q3.dates, q3.ret, y), b = seriesYear(pool.dates, pool.ret, y), c = seriesYear(d4.dates, d4.ret, y);
    console.log(`| ${y} | ${y <= 2020 ? "학습" : "확인"} | ${f2(a)} | ${f2(b)} | ${f2(c)} | ${f2(a - b)} | ${f2(a - c)} |`);
  }

  console.log("\n=== 2. 005930·005935·000660 제외 재계산 (풀에서 처음부터 제외, 같은 규칙) ===");
  console.log("| 구성 | 구간 | CAGR % | MDD % | CAGR÷MDD |\n|---|---|---|---|---|");
  for (const [lab, o] of [["Q3(원래)", q3], ["POOL(원래)", pool], ["Q3(3종목 제외)", q3x], ["POOL(3종목 제외)", poolx]] as [string, Out][]) for (const [wn, win] of W3) { const s = st(o.dates, o.ret, win); console.log(`| ${lab} | ${wn} | ${f2(s.cagr)} | ${f2(s.mdd)} | ${f2(s.cm)} |`); }
  console.log("| 차이 Q3 − POOL | 구간 | CAGR %p (원래) | CAGR %p (제외) | MDD %p (원래) | MDD %p (제외) |\n|---|---|---|---|---|---|");
  for (const [wn, win] of W3) { const a = st(q3.dates, q3.ret, win), b = st(pool.dates, pool.ret, win), c = st(q3x.dates, q3x.ret, win), d = st(poolx.dates, poolx.ret, win); console.log(`| Q3 − POOL | ${wn} | ${f2(a.cagr - b.cagr)} | ${f2(c.cagr - d.cagr)} | ${f2(a.mdd - b.mdd)} | ${f2(c.mdd - d.mdd)} |`); }

  console.log("\n=== 3. 종목별 초과 기여 (전체 구간 2016-06-01~, (Q3 비중 − POOL 비중) × 일수익의 일별 합, %p) ===");
  const diff = new Map<string, number>();
  let sumRetDiff = 0, sumCostDiff = 0, nDays = 0;
  for (let i = 0; i < q3.dates.length; i++) {
    if (q3.dates[i] < WIN_START || q3.dates[i] !== pool.dates[i]) continue;
    nDays++;
    sumRetDiff += q3.ret[i] - pool.ret[i];
    sumCostDiff += (q3.costFrac[i] - pool.costFrac[i]) * 100;
    for (const [c, v] of q3.contrib[i]) diff.set(c, (diff.get(c) ?? 0) + v);
    for (const [c, v] of pool.contrib[i]) diff.set(c, (diff.get(c) ?? 0) - v);
  }
  const sorted = [...diff.entries()].sort((a, b) => b[1] - a[1]);
  console.log("상위 10:\n| 종목 | 초과 기여 %p |\n|---|---|");
  for (const [c, v] of sorted.slice(0, 10)) console.log(`| ${c} | ${f2(v * 100)} |`);
  console.log("하위 10:\n| 종목 | 초과 기여 %p |\n|---|---|");
  for (const [c, v] of sorted.slice(-10).reverse()) console.log(`| ${c} | ${f2(v * 100)} |`);
  const total = [...diff.values()].reduce((a, x) => a + x, 0) * 100;
  const pos = sorted.filter((x) => x[1] > 0).reduce((a, x) => a + x[1], 0) * 100, neg = sorted.filter((x) => x[1] < 0).reduce((a, x) => a + x[1], 0) * 100;
  console.log(`종목 수 ${sorted.length} | 합계 ${f2(total)}%p (양수 합 ${f2(pos)}, 음수 합 ${f2(neg)}) | 같은 일수 ${nDays}일의 (Q3 일수익률 − POOL 일수익률) 합 ${f2(sumRetDiff)}%p | 일별 비용 비율 차(Q3 − POOL) 합 ${f2(sumCostDiff)}%p`);
  for (const code of ["000660", "005930", "005935"]) console.log(`  ${code} 초과 기여 ${f2((diff.get(code) ?? 0) * 100)}%p (순위 ${sorted.findIndex((x) => x[0] === code) + 1}/${sorted.length})`);

  console.log("\n=== 4. 000660·005930 Q3 리밸런스일(5·8·11월 말)별 배수와 S_OP 분위 ===");
  const q3Dates = [...rebalSet("Q3")].sort();
  interface Inf { inPool: boolean; mult: number | null; quint: number | null }
  const infoAt = (d: string, code: string): Inf => {
    const poolD = poolAt(d);
    if (!poolD.some((x) => x.sk.code === code)) return { inPool: false, mult: null, quint: null };
    const sg = signals(poolD, d, "op");
    const n = sg.length, k = Math.floor(n / 5);
    const idx = sg.findIndex((x) => x.code === code);
    if (idx < 0) return { inPool: true, mult: 1, quint: null };
    return { inPool: true, mult: k > 0 && idx < k ? 2 : k > 0 && idx >= n - k ? 0.5 : 1, quint: Math.floor((idx * 5) / n) + 1 };
  };
  const rowsInfo = q3Dates.map((d) => ({ d, a: infoAt(d, "000660"), b: infoAt(d, "005930") }));
  const fmt = (x: Inf): string => (!x.inPool ? "풀 밖" : x.quint === null ? "×1 / 신호 없음" : `×${x.mult} / ${x.quint}분위`);
  console.log("| 리밸런스일 | 000660 (배수 / S_OP 분위) | 005930 (배수 / S_OP 분위) |\n|---|---|---|");
  for (const r of rowsInfo) console.log(`| ${r.d} | ${fmt(r.a)} | ${fmt(r.b)} |`);
  console.log("\n연도별 집계(해당 연도 Q3 리밸런스 횟수 중):");
  console.log("| 연도 | 리밸런스 수 | 000660 ×2 | ×1 | ×0.5 | 풀 밖 | 평균 배수(풀 안) | 005930 ×2 | ×1 | ×0.5 | 풀 밖 | 평균 배수(풀 안) |\n|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const y of years) {
    const rs = rowsInfo.filter((r) => r.d.startsWith(`${y}-`));
    if (!rs.length) continue;
    const agg = (get: (r: (typeof rs)[number]) => Inf): string => {
      const v = rs.map(get);
      const inP = v.filter((x) => x.inPool);
      const avg = inP.length ? inP.reduce((a, x) => a + (x.mult as number), 0) / inP.length : NaN;
      return `${v.filter((x) => x.mult === 2).length} | ${v.filter((x) => x.mult === 1).length} | ${v.filter((x) => x.mult === 0.5).length} | ${v.filter((x) => !x.inPool).length} | ${f2(avg)}`;
    };
    console.log(`| ${y} | ${rs.length} | ${agg((r) => r.a)} | ${agg((r) => r.b)} |`);
  }

  console.log("\n=== 5. 확인 구간 정보용 지표 (S_OP, 학습 구간과 같은 정의) ===");
  const infoMonthsC = monthEnds.filter((d, k) => d >= LEARN_END && k + 1 < monthEnds.length);
  const infoMonthsL = monthEnds.filter((d, k) => d >= firstRebal && k + 1 < monthEnds.length && monthEnds[k + 1] <= LEARN_END);
  const nextOf = (d: string): string => monthEnds[monthEnds.indexOf(d) + 1];
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
  const infoFor = (months: string[]) => {
    const rhos: number[] = [], cover: number[] = [], nSig: number[] = [];
    const qSum = [0, 0, 0, 0, 0], qCnt = [0, 0, 0, 0, 0];
    for (const d of months) {
      const poolD = poolAt(d);
      const sg = signals(poolD, d, "op");
      nSig.push(sg.length); cover.push(poolD.length ? sg.length / poolD.length : 0);
      const nd = nextOf(d);
      const pairs: { s: number; r: number }[] = [];
      const bucket: number[][] = [[], [], [], [], []];
      sg.forEach((x, i) => {
        const sk = byCode.get(x.code)!;
        const i0 = sk.idx.get(d), i1 = sk.idx.get(nd);
        if (i0 === undefined || i1 === undefined) return;
        const r = sk.close[i1] / sk.close[i0] - 1;
        pairs.push({ s: x.s, r });
        bucket[Math.floor((i * 5) / sg.length)].push(r);
      });
      if (pairs.length < 5) continue;
      const rho = corr(rank(pairs.map((p) => p.s)), rank(pairs.map((p) => p.r)));
      if (Number.isFinite(rho)) rhos.push(rho);
      bucket.forEach((b, j) => { if (b.length) { qSum[j] += b.reduce((a, x) => a + x, 0) / b.length; qCnt[j]++; } });
    }
    const m = rhos.reduce((a, x) => a + x, 0) / Math.max(rhos.length, 1);
    const sd = Math.sqrt(rhos.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(rhos.length - 1, 1));
    return { months: months.length, used: rhos.length, m, t: m / (sd / Math.sqrt(rhos.length)), cover: cover.reduce((a, x) => a + x, 0) / Math.max(cover.length, 1), nSig: nSig.reduce((a, x) => a + x, 0) / Math.max(nSig.length, 1), q: qSum.map((s, j) => (qCnt[j] ? (s / qCnt[j]) * 100 : NaN)) };
  };
  console.log(`확인 구간 대상 월: 월말 d ≥ ${LEARN_END}이고 다음 월말이 있는 달 (${infoMonthsC[0]} ~ ${infoMonthsC[infoMonthsC.length - 1]}, ${infoMonthsC.length}개월; 다음 달 수익률 구간은 모두 ${CONFIRM_START} 이후)`);
  console.log("| 구간 | 대상 월 | 상관 계산 월 | 스피어만 상관 월 평균 | t값 | 신호 있는 종목 비율(월평균 %) | 신호 있는 종목 수(월평균) | 분위1(상위) 다음 달 평균 % | 분위2 | 분위3 | 분위4 | 분위5(하위) |\n|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const [lab, months] of [["확인", infoMonthsC], ["학습(이전 보고와 같은 값 확인용)", infoMonthsL]] as [string, string[]][]) { const r = infoFor(months); console.log(`| ${lab} | ${r.months} | ${r.used} | ${r.m.toFixed(4)} | ${f2(r.t)} | ${f2(r.cover * 100)} | ${r.nSig.toFixed(1)} | ${r.q.map(f2).join(" | ")} |`); }

  console.log("\n=== 실행 지표 ===");
  console.log(`Supabase 읽은 행: ${Object.entries(dbRead).map(([k, v]) => `${k} ${v}`).join(" | ")} | 합계 ${Object.values(dbRead).reduce((a, b) => a + b, 0)}`);
  console.log(`Supabase 쓴 행: 0 | 외부 요청(DART/KIS 등): 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
