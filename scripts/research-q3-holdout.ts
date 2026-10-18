/**
 * [임시 연구 — 병합 금지, 읽기 전용, 외부 요청 0건] Q3 홀드아웃 판정 (2011-06-01~2016-05-31, 누적 시도 98).
 * 사전 등록: research/quarterly-tilt-holdout-prereg.md (커밋 5df8ab2), Q3 정의: research/quarterly-tilt-prereg.md (커밋 bec9a35).
 * 데이터: dart_quarterly_fundamentals의 singl + xbrl 행(status='ok'). 숫자와 표, O/X만 출력한다.
 */
import { getIndexPriceSeries } from "@/lib/betaPriceHistoryStorage";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadAllStockSeriesFromParquet } from "@/lib/stockDailyPricesStorage";
import { loadAppliedAdjustments } from "@/lib/stockPriceAdjustmentsStorage";
import { computeTrailingAvgTradingValue } from "@/lib/pitUniverse";
import { PIT_LIQUIDITY_LOOKBACK_DAYS, PIT_MIN_AVG_TRADING_VALUE_WON } from "@/lib/strategyBacktestSummaryConfig";
import { computeCumulativeAndMdd, computeCagrPct } from "@/lib/strategyBacktestSummary";
import { computeIndexDailyReturnsPct } from "@/lib/benchmarkSummary";
import { computeEffectiveBuyPrice, computeEffectiveSellPrice } from "@/lib/transactionCost";

const T0 = Date.now();
const TODAY = new Date().toISOString().slice(0, 10);
const CAP_EOK = 5000;
const POOL_SIZE = 100;
const WIN_START = "2011-06-01", HOLD_END = "2016-05-31";
const FIRST_REBAL_MONTH = "2011-05";
const FRESH_DAYS = 150;
const TILT_UP = 2, TILT_DOWN = 0.5, W_CAP = 0.2, FULL_N = 5;
const H3_MARGIN = 3.0, H5_MAX_DROP = 1.0;
const SEASON_MONTHS = [5, 8, 11];
const ENDED_GRACE_DAYS = 14;
const EOK = 1e8;
const MS_DAY = 86_400_000;
const QEND: Record<number, string> = { 1: "03-31", 2: "06-30", 3: "09-30" };
const EX3 = new Set(["005930", "005935", "000660"]);
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
interface Rec { rcept: string; order: number; opD: number | null; niD: number | null; fs: string | null; src: string | null }
interface Out { dates: string[]; ret: number[]; costFrac: number[]; turn: { d: string; v: number }[]; contrib: Map<string, number>[] }
interface Win { from: string; to: string }
type Kind = "Q1" | "Q2" | "Q3" | "Q4" | "POOL" | "D4";

async function main(): Promise<void> {
  console.log(`Q3 홀드아웃(2011-06-01~2016-05-31) 시작(읽기 전용): ${new Date().toISOString()} (사전등록 5df8ab2, Q3 정의 bec9a35)`);
  const adjustments = await loadAppliedAdjustments();
  dbRead["stock_price_adjustment_events(applied)"] = [...adjustments.values()].reduce((a, l) => a + l.length, 0);
  const series = await loadAllStockSeriesFromParquet(2010, new Date().getUTCFullYear(), adjustments);
  const kospi = await getIndexPriceSeries("KOSPI", "2011-01-01", TODAY);
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
  console.log(`종목 ${stocks.length}개, 거래일(2011-05~) ${CALF.length}일 ${CALF[0]}~${dataEnd}, 월말 ${monthEnds.length}개`);

  // ---- 분기 레코드(singl + xbrl, status='ok'; 4분기 파생 없음 — 홀드아웃 prereg 보충 2항) ----
  interface QRowDb { corp_code: string; stock_code: string; fiscal_year: number; quarter: number; fs_div: string | null; source: string | null; rcept_date: string | null; ni_parent_q: number | null; ni_parent_prev_q: number | null; op_income_q: number | null; op_income_prev_q: number | null; off_cycle: boolean }
  const q = await selectAll<QRowDb>("dart_quarterly_fundamentals(ok)", (f, t) => supabaseAdmin.from("dart_quarterly_fundamentals").select("corp_code, stock_code, fiscal_year, quarter, fs_div, source, rcept_date, ni_parent_q, ni_parent_prev_q, op_income_q, op_income_prev_q, off_cycle").eq("status", "ok").order("corp_code").order("fiscal_year").order("quarter").range(f, t));
  const recsBy = new Map<string, Rec[]>();
  const excl = { total: q.length, offCycle: 0, rceptNull: 0, rceptBeforeQEnd: 0, used: 0, usedXbrl: 0, usedSingl: 0 };
  for (const r of q) {
    if (r.off_cycle) { excl.offCycle++; continue; }
    if (!r.rcept_date) { excl.rceptNull++; continue; }
    if (r.rcept_date < `${r.fiscal_year}-${QEND[r.quarter]}`) { excl.rceptBeforeQEnd++; continue; }
    excl.used++;
    if (r.source === "xbrl") excl.usedXbrl++; else excl.usedSingl++;
    const opD = r.op_income_q !== null && r.op_income_prev_q !== null ? Number(r.op_income_q) - Number(r.op_income_prev_q) : null;
    const niD = r.ni_parent_q !== null && r.ni_parent_prev_q !== null ? Number(r.ni_parent_q) - Number(r.ni_parent_prev_q) : null;
    (recsBy.get(r.stock_code) ?? recsBy.set(r.stock_code, []).get(r.stock_code)!).push({ rcept: r.rcept_date, order: r.fiscal_year * 10 + r.quarter, opD, niD, fs: r.fs_div, src: r.source });
  }
  for (const l of recsBy.values()) l.sort((x, y) => (x.rcept < y.rcept ? -1 : x.rcept > y.rcept ? 1 : x.order - y.order));
  /** 기준일 t의 가장 최근 분기 레코드(rcept ≤ t, 150일 이내) */
  function recAt(code: string, t: string): Rec | null {
    const l = recsBy.get(code);
    if (!l) return null;
    let rec: Rec | null = null;
    for (const r of l) { if (r.rcept <= t) rec = r; else break; }
    if (!rec || dayDiff(rec.rcept, t) > FRESH_DAYS) return null;
    return rec;
  }
  function numer(code: string, t: string): { op: number | null; ni: number | null } {
    const rec = recAt(code, t);
    return rec ? { op: rec.opD, ni: rec.niD } : { op: null, ni: null };
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
  const HOLD: Win = { from: WIN_START, to: HOLD_END };
  const seriesYear = (dates: string[], rets: number[], y: number): number => computeCumulativeAndMdd(rets.filter((_, i) => dates[i].startsWith(`${y}-`))).totalReturnPct;
  const kp = kospi.filter((p) => p.tradeDate >= "2011-05-01");
  const kRets = computeIndexDailyReturnsPct(kp as never);
  const kDates = kp.slice(1).map((p) => p.tradeDate);


  // ---- 홀드아웃 실행 ----
  const mkRun = (k: Kind, delay: boolean): Out => run(k, delay, HOLD_END);
  const q3 = mkRun("Q3", false), q3d = mkRun("Q3", true), pool = mkRun("POOL", false), d4 = mkRun("D4", false);
  excludeSet = EX3;
  const q3x = mkRun("Q3", false), poolx = mkRun("POOL", false);
  excludeSet = new Set();
  console.log(`홀드아웃 경로 계산 완료(첫 리밸런스 ${firstRebal}, 마지막 평가일 ${q3.dates[q3.dates.length - 1]}), 경과 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
  console.log(`데이터 행: status='ok' ${excl.total}건 중 off_cycle 제외 ${excl.offCycle}, rcept_date < 분기 말 제외 ${excl.rceptBeforeQEnd}, rcept_date 없음 ${excl.rceptNull}, 사용 ${excl.used} (xbrl ${excl.usedXbrl}, singl ${excl.usedSingl})`);

  const S = {
    Q3: st(q3.dates, q3.ret, HOLD, q3.costFrac, q3.turn), POOL: st(pool.dates, pool.ret, HOLD, pool.costFrac, pool.turn),
    D4: st(d4.dates, d4.ret, HOLD, d4.costFrac, d4.turn), KOSPI: st(kDates, kRets, HOLD), Q3d: st(q3d.dates, q3d.ret, HOLD, q3d.costFrac, q3d.turn),
  };
  console.log("\n=== (b) 홀드아웃 표 (2011-06-01~2016-05-31) ===");
  console.log("| 구성 | CAGR % | MDD % | CAGR÷MDD | 연변동성 % | 연 회전율 % | 누적 비용 % |\n|---|---|---|---|---|---|---|");
  for (const [lab, s] of [["Q3", S.Q3], ["POOL", S.POOL], ["D4", S.D4], ["KOSPI", S.KOSPI]] as const) console.log(`| ${lab} | ${f2(s.cagr)} | ${f2(s.mdd)} | ${f2(s.cm)} | ${f2(s.vol)} | ${Number.isFinite(s.turnover) ? f2(s.turnover) : "-"} | ${Number.isFinite(s.cost) ? f2(s.cost) : "-"} |`);

  const drop = S.Q3.cagr - S.Q3d.cagr;
  const crit: [string, string, boolean][] = [
    ["H1 CAGR > POOL", `${f2(S.Q3.cagr)} vs ${f2(S.POOL.cagr)}`, S.Q3.cagr > S.POOL.cagr],
    ["H2 CAGR > D4", `${f2(S.Q3.cagr)} vs ${f2(S.D4.cagr)}`, S.Q3.cagr > S.D4.cagr],
    ["H3 MDD ≤ POOL MDD + 3.0%p", `${f2(S.Q3.mdd)} vs ${f2(S.POOL.mdd + H3_MARGIN)}`, S.Q3.mdd <= S.POOL.mdd + H3_MARGIN],
    ["H4 CAGR÷MDD > POOL", `${f2(S.Q3.cm)} vs ${f2(S.POOL.cm)}`, S.Q3.cm > S.POOL.cm],
    ["H5 +1거래일 지연 시 CAGR 하락 ≤ 1.0%p", `기본 ${f2(S.Q3.cagr)} → 지연 ${f2(S.Q3d.cagr)} (하락 ${f2(drop)}%p)`, drop <= H5_MAX_DROP],
  ];
  console.log("\n=== (c) H1~H5 ===\n| 기준 | 수치 | O/X |\n|---|---|---|");
  for (const [n, v, ok] of crit) console.log(`| ${n} | ${v} | ${ox(ok)} |`);
  console.log(`홀드아웃 통과 표시: ${crit.every((c) => c[2]) ? "통과(전부 O)" : "통과 아님"}`);
  console.log(`지연(+1거래일) Q3: CAGR ${f2(S.Q3d.cagr)} / MDD ${f2(S.Q3d.mdd)} / CAGR÷MDD ${f2(S.Q3d.cm)} / 연변동성 ${f2(S.Q3d.vol)} / 연 회전율 ${f2(S.Q3d.turnover)} / 누적 비용 ${f2(S.Q3d.cost)}`);

  console.log("\n=== (d) 연도별 수익률 % (2011은 6월부터, 2016은 5월까지) ===");
  const years = [2011, 2012, 2013, 2014, 2015, 2016];
  console.log("| 구성 | " + years.join(" | ") + " |\n|---|" + years.map(() => "---").join("|") + "|");
  const yrOf = (dates: string[], rets: number[], y: number): number => { const ix = dates.map((d, i) => (d.startsWith(`${y}-`) && d >= WIN_START && d <= HOLD_END ? i : -1)).filter((i) => i >= 0); return computeCumulativeAndMdd(ix.map((i) => rets[i])).totalReturnPct; };
  const rowsY: [string, string[], number[]][] = [["Q3", q3.dates, q3.ret], ["POOL", pool.dates, pool.ret], ["D4", d4.dates, d4.ret], ["KOSPI", kDates, kRets]];
  for (const [lab, dd, rr] of rowsY) console.log(`| ${lab} | ${years.map((y) => f2(yrOf(dd, rr, y))).join(" | ")} |`);
  console.log(`| Q3 − POOL | ${years.map((y) => f2(yrOf(q3.dates, q3.ret, y) - yrOf(pool.dates, pool.ret, y))).join(" | ")} |`);

  console.log("\n=== (e) 정보용 ===");
  console.log("005930·005935·000660 제외 재계산:\n| 구성 | CAGR % | MDD % | CAGR÷MDD |\n|---|---|---|---|");
  for (const [lab, o] of [["Q3(3종목 제외)", q3x], ["POOL(3종목 제외)", poolx]] as [string, Out][]) { const s = st(o.dates, o.ret, HOLD); console.log(`| ${lab} | ${f2(s.cagr)} | ${f2(s.mdd)} | ${f2(s.cm)} |`); }
  { const a = st(q3x.dates, q3x.ret, HOLD), b = st(poolx.dates, poolx.ret, HOLD); console.log(`Q3 − POOL (3종목 제외): CAGR ${f2(a.cagr - b.cagr)}%p, MDD ${f2(a.mdd - b.mdd)}%p (제외 전: CAGR ${f2(S.Q3.cagr - S.POOL.cagr)}%p, MDD ${f2(S.Q3.mdd - S.POOL.mdd)}%p)`); }

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
  const infoMonths = monthEnds.filter((d, k) => d >= firstRebal && k + 1 < monthEnds.length && monthEnds[k + 1] <= HOLD_END);
  const nextOf = (d: string): string => monthEnds[monthEnds.indexOf(d) + 1];
  {
    const rhos: number[] = [], cover: number[] = [], nSig: number[] = [];
    const qSum = [0, 0, 0, 0, 0], qCnt = [0, 0, 0, 0, 0];
    for (const d of infoMonths) {
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
    console.log(`\nS_OP 스피어만 상관(월 평균·t값) / 5분위별 다음 달 평균 수익률 (대상 월 ${infoMonths.length}개: ${infoMonths[0]} ~ ${infoMonths[infoMonths.length - 1]})`);
    console.log("| 상관 계산 월 | 스피어만 상관 월 평균 | t값 | 신호 있는 종목 비율(월평균 %) | 신호 있는 종목 수(월평균) | 분위1(상위) 다음 달 평균 % | 분위2 | 분위3 | 분위4 | 분위5(하위) |\n|---|---|---|---|---|---|---|---|---|---|");
    console.log(`| ${rhos.length} | ${m.toFixed(4)} | ${f2(m / (sd / Math.sqrt(rhos.length)))} | ${f2((cover.reduce((a, x) => a + x, 0) / Math.max(cover.length, 1)) * 100)} | ${(nSig.reduce((a, x) => a + x, 0) / Math.max(nSig.length, 1)).toFixed(1)} | ${qSum.map((s, j) => f2(qCnt[j] ? (s / qCnt[j]) * 100 : NaN)).join(" | ")} |`);
  }
  {
    const ix: number[] = [];
    for (let i = 0; i < q3.dates.length; i++) if (q3.dates[i] >= WIN_START && q3.dates[i] <= HOLD_END && q3.dates[i] === pool.dates[i]) ix.push(i);
    const x = ix.map((i) => pool.ret[i]), y = ix.map((i) => q3.ret[i]);
    const mx = x.reduce((a, v) => a + v, 0) / x.length, my = y.reduce((a, v) => a + v, 0) / y.length;
    let sxy = 0, sxx = 0;
    for (let i = 0; i < x.length; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; }
    const beta = sxy / sxx;
    const alphaAnn = (my - beta * mx) * 252;
    const resid = y.map((v, i) => v - (my - beta * mx) - beta * x[i]);
    const rs = Math.sqrt(resid.reduce((a, v) => a + v * v, 0) / Math.max(resid.length - 2, 1));
    console.log(`\nPOOL 대비 회귀 r_Q3 = α + β·r_POOL (일 수익률 %, ${ix.length}일): β ${beta.toFixed(4)}, 연 α(산술) ${f2(alphaAnn)}%, 잔차 표준편차(일) ${rs.toFixed(4)}%, 연 초과수익 CAGR 차이(Q3 − POOL) ${f2(S.Q3.cagr - S.POOL.cagr)}%p`);
  }

  console.log("\n=== (f) 커버리지 (Q3 리밸런스일 = 5·8·11월 말, 풀 100종목 중) ===");
  const q3Dates = [...rebalSet("Q3")].filter((d) => d <= HOLD_END).sort();
  const dead = new Set(stocks.filter((s) => s.last < endedBefore).map((s) => s.code));
  const cov: { d: string; n: number; poolN: number; cfs: number; ofs: number; nul: number; deadPool: number; deadSig: number; liveSig: number; livePool: number }[] = [];
  for (const d of q3Dates) {
    const p = poolAt(d);
    const sg = signals(p, d, "op");
    const sset = new Set(sg.map((x) => x.code));
    let cfs = 0, ofs = 0, nul = 0, deadPool = 0, deadSig = 0, liveSig = 0, livePool = 0;
    for (const x of p) {
      const has = sset.has(x.sk.code);
      if (dead.has(x.sk.code)) { deadPool++; if (has) deadSig++; } else { livePool++; if (has) liveSig++; }
      if (has) { const fs = recAt(x.sk.code, d)?.fs; if (fs === "CFS") cfs++; else if (fs === "OFS") ofs++; else nul++; }
    }
    cov.push({ d, n: sg.length, poolN: p.length, cfs, ofs, nul, deadPool, deadSig, liveSig, livePool });
  }
  console.log(`리밸런스일 ${cov.length}개: 풀 중 S_OP 있는 종목 수 평균 ${f2(cov.reduce((a, c) => a + c.n, 0) / cov.length)} / 최소 ${Math.min(...cov.map((c) => c.n))} / 최대 ${Math.max(...cov.map((c) => c.n))} (풀 크기 평균 ${f2(cov.reduce((a, c) => a + c.poolN, 0) / cov.length)})`);
  console.log("| 연도 | 리밸런스 수 | S_OP 종목 수 평균 | 최소 | CFS 비율 % | OFS 비율 % | fs_div null 비율 % | 상장폐지 종목 풀 내 수(합) | 그중 S_OP 있음 | 생존 종목 풀 내 수(합) | 그중 S_OP 있음 |\n|---|---|---|---|---|---|---|---|---|---|---|");
  for (const y of years) {
    const cs = cov.filter((c) => c.d.startsWith(`${y}-`));
    if (!cs.length) continue;
    const tot = cs.reduce((a, c) => a + c.cfs + c.ofs + c.nul, 0);
    const sm = (f: (c: (typeof cs)[number]) => number): number => cs.reduce((a, c) => a + f(c), 0);
    console.log(`| ${y} | ${cs.length} | ${f2(sm((c) => c.n) / cs.length)} | ${Math.min(...cs.map((c) => c.n))} | ${f2((sm((c) => c.cfs) / Math.max(tot, 1)) * 100)} | ${f2((sm((c) => c.ofs) / Math.max(tot, 1)) * 100)} | ${f2((sm((c) => c.nul) / Math.max(tot, 1)) * 100)} | ${sm((c) => c.deadPool)} | ${sm((c) => c.deadSig)} | ${sm((c) => c.livePool)} | ${sm((c) => c.liveSig)} |`);
  }
  { const dp = cov.reduce((a, c) => a + c.deadPool, 0), ds = cov.reduce((a, c) => a + c.deadSig, 0), lp = cov.reduce((a, c) => a + c.livePool, 0), ls = cov.reduce((a, c) => a + c.liveSig, 0); console.log(`상장폐지 종목 중 S_OP 있는 비율(전 리밸런스일 합): ${ds} / ${dp} (${f2((ds / Math.max(dp, 1)) * 100)}%), 생존 종목: ${ls} / ${lp} (${f2((ls / Math.max(lp, 1)) * 100)}%)`); }

  console.log("\n=== (g) 초과 기여 상위·하위 5종목 ((Q3 비중 − POOL 비중) × 일수익의 일별 합, %p) ===");
  const diff = new Map<string, number>();
  for (let i = 0; i < q3.dates.length; i++) {
    if (q3.dates[i] < WIN_START || q3.dates[i] !== pool.dates[i]) continue;
    for (const [c, v] of q3.contrib[i]) diff.set(c, (diff.get(c) ?? 0) + v);
    for (const [c, v] of pool.contrib[i]) diff.set(c, (diff.get(c) ?? 0) - v);
  }
  const sorted = [...diff.entries()].sort((a, b) => b[1] - a[1]);
  console.log("| 구분 | 종목 | 초과 기여 %p |\n|---|---|---|");
  for (const [c, v] of sorted.slice(0, 5)) console.log(`| 상위 | ${c} | ${f2(v * 100)} |`);
  for (const [c, v] of sorted.slice(-5).reverse()) console.log(`| 하위 | ${c} | ${f2(v * 100)} |`);
  console.log(`종목 수 ${sorted.length}, 합계 ${f2([...diff.values()].reduce((a, x) => a + x, 0) * 100)}%p`);

  console.log("\n=== (h) 실행 지표 ===");
  console.log(`Supabase 읽은 행: ${Object.entries(dbRead).map(([k, v]) => `${k} ${v}`).join(" | ")} | 합계 ${Object.values(dbRead).reduce((a, b) => a + b, 0)}`);
  console.log(`Supabase 쓴 행: 0 | 외부 요청(DART/KIS 등): 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
