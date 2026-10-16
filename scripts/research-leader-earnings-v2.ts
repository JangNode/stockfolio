/**
 * [임시 연구 — 병합 금지, 읽기 전용, 외부 요청 0건] leader_earnings 강화: 사전등록 16변형 → 학습 1개 자동 선택 → 확인 1회 (T72~87).
 * 사전 등록: research/leader-earnings-v2-prereg.md (커밋 9d8088a). 정의·선택 규칙은 그 문서가 고정한다. 숫자와 표, O/X만 출력한다.
 */
import { getIndexPriceSeries } from "@/lib/betaPriceHistoryStorage";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadAllStockSeriesFromParquet } from "@/lib/stockDailyPricesStorage";
import { loadAppliedAdjustments } from "@/lib/stockPriceAdjustmentsStorage";
import { computeTrailingAvgTradingValue } from "@/lib/pitUniverse";
import { PIT_LIQUIDITY_LOOKBACK_DAYS, PIT_MIN_AVG_TRADING_VALUE_WON } from "@/lib/strategyBacktestSummaryConfig";
import { computeCumulativeAndMdd, computeCagrPct } from "@/lib/strategyBacktestSummary";
import { computeIndexDailyReturnsPct, simulateUniverseMonthlyRebalance } from "@/lib/benchmarkSummary";
import { computeEffectiveBuyPrice, computeEffectiveSellPrice } from "@/lib/transactionCost";
import { PERIOD_START, TODAY, CAP_EOK } from "./research-ma-lab";
import type { Sk } from "./research-audit-peg";

const T0 = Date.now();
const POOL_SIZE = 100, MOM_LONG = 252, MOM_SHORT = 21, CAND_N = 30, BUFFER_RANK = 45, FULL_N = 5, W_CAP = 0.2, SMA_N = 200, TILT = 2;
const START_MONTH = "2012-03";
const LEARN = { from: "2012-04-01", to: "2018-12-31" }, CONFIRM = { from: "2019-01-01", to: "9999-12-31" }, FULL = { from: "2012-04-01", to: "9999-12-31" };
const QUAL_MDD_MARGIN = 5.0, C2_MARGIN = 5.0, C5_MAX_DROP = 1.0;
const ENDED_GRACE_DAYS = 14;
const MS_DAY = 86_400_000;
const f2 = (x: number): string => (Number.isFinite(x) ? x.toFixed(2) : "-");
const ox = (b: boolean): string => (b ? "O" : "X");
const mean = (v: number[]): number => (v.length ? v.reduce((a, x) => a + x, 0) / v.length : NaN);
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

interface FRow { fy: number; rcept: string; ni: number | null; fs: string }
interface TargetMeta { nSel: number; total: number; maxSel: number }
interface Target { w: Map<string, number>; meta?: TargetMeta }
interface RebalLog { date: string; nSel: number; maxSel: number; maxAll: number; nPos: number; turnover: number; weights: Map<string, number> }
interface SimOut { dates: string[]; ret: number[]; costFrac: number[]; logs: RebalLog[]; contrib: Map<string, number>[] }
interface Variant { name: string; a: 1 | 2; K: 15 | 30; c: 1 | 2; d: 1 | 2 }

async function main(): Promise<void> {
  console.log(`leader_earnings 강화(T72~87) 시작(읽기 전용): ${new Date().toISOString()} (사전등록 9d8088a 이후)`);
  const adjustments = await loadAppliedAdjustments();
  dbRead["stock_price_adjustment_events(applied)"] = [...adjustments.values()].reduce((a, l) => a + l.length, 0);
  const series = await loadAllStockSeriesFromParquet(2010, new Date().getUTCFullYear(), adjustments);
  const funds = await selectAll<{ stock_code: string; fiscal_year: number; rcept_date: string; net_income_parent: number | null; fs_div: string }>("stock_annual_fundamentals", (f, t) => supabaseAdmin.from("stock_annual_fundamentals").select("stock_code, fiscal_year, rcept_date, net_income_parent, fs_div").order("stock_code").order("fiscal_year").range(f, t));
  const fundBy = new Map<string, FRow[]>();
  for (const r of funds) fundBy.set(r.stock_code, [...(fundBy.get(r.stock_code) ?? []), { fy: r.fiscal_year, rcept: r.rcept_date, ni: r.net_income_parent === null ? null : Number(r.net_income_parent), fs: r.fs_div }]);

  const calSet = new Set<string>();
  let globalLast = "";
  const stocks: Sk[] = [];
  const prefix = new Map<string, Float64Array>();
  const lastDateOf = new Map<string, string>();
  const pricesByStock = new Map<string, { date: string; close: number }[]>();
  for (const [code, rows] of series) {
    for (const r of rows) if (r.tradeDate >= PERIOD_START) calSet.add(r.tradeDate);
    const l = rows[rows.length - 1].tradeDate;
    if (l > globalLast) globalLast = l;
    lastDateOf.set(code, l);
    const close = Float64Array.from(rows.map((r) => r.closePrice));
    const pre = new Float64Array(close.length + 1);
    for (let i = 0; i < close.length; i++) pre[i + 1] = pre[i] + close[i];
    prefix.set(code, pre);
    stocks.push({ code, dates: rows.map((r) => r.tradeDate), close, mcap: Float64Array.from(rows.map((r) => r.marketCapEok)), avgTv: computeTrailingAvgTradingValue(rows, PIT_LIQUIDITY_LOOKBACK_DAYS), idx: new Map(rows.map((r, i) => [r.tradeDate, i])) });
    pricesByStock.set(code, rows.map((r) => ({ date: r.tradeDate, close: r.closePrice })));
  }
  const CAL = [...calSet].sort();
  const monthEndSet = new Set<string>();
  for (let k = 0; k + 1 < CAL.length; k++) if (CAL[k].slice(0, 7) !== CAL[k + 1].slice(0, 7)) monthEndSet.add(CAL[k]);
  const monthEnds = [...monthEndSet].sort().filter((d) => d.slice(0, 7) >= START_MONTH);
  const quarterEnds = new Set(monthEnds.filter((d) => [3, 6, 9, 12].includes(Number(d.slice(5, 7)))));
  const allMonthSet = new Set(monthEnds);
  const startD = monthEnds[0];
  const endedBefore = new Date(Date.parse(globalLast) - ENDED_GRACE_DAYS * MS_DAY).toISOString().slice(0, 10);
  console.log(`종목 ${stocks.length}개, 거래일 ${CAL.length}일, 데이터 끝 ${globalLast}, 첫 리밸런스 ${startD}, 월말 ${monthEnds.length}개`);
  const byCode = new Map(stocks.map((s) => [s.code, s]));
  const buyRate = computeEffectiveBuyPrice(1) - 1;

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
  const earnOk = (code: string, d: string): boolean => {
    const vis = (fundBy.get(code) ?? []).filter((r) => r.rcept <= d);
    if (!vis.length) return false;
    const E = Math.max(...vis.map((r) => r.fy));
    const cur = vis.find((r) => r.fy === E), prev = vis.find((r) => r.fy === E - 1);
    if (!cur || !prev || cur.ni === null || prev.ni === null || cur.fs !== prev.fs) return false;
    return cur.ni > 0 && cur.ni > prev.ni;
  };
  const below = (code: string, d: string): boolean => {
    const sk = byCode.get(code)!;
    const i = sk.idx.get(d);
    if (i === undefined || i < SMA_N - 1) return false;
    const pre = prefix.get(code)!;
    return sk.close[i] < (pre[i + 1] - pre[i + 1 - SMA_N]) / SMA_N;
  };
  const d4Target = (d: string): Target => { const el = eligibleAt(d); const tot = el.reduce((a, x) => a + x.mcap, 0); return { w: new Map(el.map((x) => [x.sk.code, x.mcap / tot])) }; };
  const poolTarget = (d: string): Target => { const pool = eligibleAt(d).sort(byMcap).slice(0, POOL_SIZE); const tot = pool.reduce((a, x) => a + x.mcap, 0); return { w: new Map(pool.map((x) => [x.sk.code, x.mcap / tot])) }; };

  /** 변형별 상태를 가진 목표 비중 함수(시뮬레이션마다 새로 만든다). */
  function makeTarget(v: Variant): (d: string) => Target {
    let prevSel: string[] = [];
    let baseSelW = new Map<string, number>(); // A1: 직전 판정의 선정 종목 비중(D4 대체분 제외)
    let baseT = 0;
    let baseW = new Map<string, number>(); // A2: 직전 판정의 종목별 비중(배수 반영)
    let baseMult = new Set<string>();
    return (d: string): Target => {
      const month = Number(d.slice(5, 7));
      const isRebal = v.c === 1 || [3, 6, 9, 12].includes(month);
      const el = eligibleAt(d);
      const totM = el.reduce((a, x) => a + x.mcap, 0);
      let nSel = prevSel.length;
      if (isRebal) {
        const pool = [...el].sort(byMcap).slice(0, POOL_SIZE);
        const moms = pool.filter((x) => x.i >= MOM_LONG).map((x) => ({ x, mom: x.sk.close[x.i - MOM_SHORT] / x.sk.close[x.i - MOM_LONG] - 1 })).filter((m) => Number.isFinite(m.mom));
        moms.sort((a, b) => b.mom - a.mom || (a.x.sk.code < b.x.sk.code ? -1 : 1));
        const rank = new Map(moms.map((m, k) => [m.x.sk.code, k + 1]));
        const passing = moms.slice(0, CAND_N).filter((m) => earnOk(m.x.sk.code, d)).map((m) => m.x.sk.code);
        let sel: string[];
        if (v.c === 1) sel = passing.slice(0, v.K);
        else {
          const retained = prevSel.filter((c) => (rank.get(c) ?? 999) <= BUFFER_RANK && earnOk(c, d));
          const rs = new Set(retained);
          sel = [...retained, ...passing.filter((c) => !rs.has(c))].slice(0, v.K);
        }
        prevSel = sel; nSel = sel.length;
        const mc = new Map(el.map((x) => [x.sk.code, x.mcap]));
        if (v.a === 1) {
          const total = nSel === 0 ? 0 : nSel >= FULL_N ? 1 : nSel * W_CAP;
          baseSelW = nSel ? capWeights(sel.map((c) => ({ code: c, m: mc.get(c)! })), total) : new Map();
          baseT = total;
        } else {
          baseMult = new Set(sel);
          const den = pool.reduce((a, x) => a + x.mcap * (baseMult.has(x.sk.code) ? TILT : 1), 0);
          baseW = new Map(pool.map((x) => [x.sk.code, (x.mcap * (baseMult.has(x.sk.code) ? TILT : 1)) / den]));
        }
      }
      let w: Map<string, number>;
      let maxSel = 0;
      if (v.a === 1) {
        const kept = new Map<string, number>();
        for (const [c, x] of baseSelW) if (!(v.d === 2 && below(c, d))) kept.set(c, x);
        const keptTotal = [...kept.values()].reduce((a, x) => a + x, 0);
        w = new Map(kept);
        const rem = 1 - keptTotal;
        if (rem > 1e-12) for (const x of el) w.set(x.sk.code, (w.get(x.sk.code) ?? 0) + (rem * x.mcap) / totM);
        maxSel = kept.size ? Math.max(...kept.values()) : 0;
      } else {
        if (v.d === 2) {
          const sc = new Map<string, number>();
          for (const [c, x] of baseW) sc.set(c, x * (baseMult.has(c) && below(c, d) ? 1 / TILT : 1));
          const s = [...sc.values()].reduce((a, x) => a + x, 0);
          w = new Map([...sc].map(([c, x]) => [c, x / s]));
        } else w = new Map(baseW);
        maxSel = Math.max(0, ...[...baseMult].map((c) => w.get(c) ?? 0));
      }
      return { w, meta: { nSel, total: v.a === 1 ? baseT : 1, maxSel } };
    };
  }

  function simulate(targetFn: (d: string) => Target, execSet: Set<string>, delay: boolean, endD: string): SimOut {
    let cash = 1, prevV = 1;
    const pos = new Map<string, { val: number; last: number }>();
    const out: SimOut = { dates: [], ret: [], costFrac: [], logs: [], contrib: [] };
    let pending: Target | null = null, pendingDate = "";
    for (const d of CAL) {
      if (d < startD) continue;
      if (d > endD) break;
      const sellRate = 1 - computeEffectiveSellPrice(1, d, "KR");
      const dayContrib = new Map<string, number>();
      let costF = 0;
      for (const [code, p] of [...pos.entries()]) {
        const sk = byCode.get(code)!;
        const i = sk.idx.get(d);
        if (i !== undefined) { const nv = (p.val * sk.close[i]) / p.last; dayContrib.set(code, (nv - p.val) / prevV); p.val = nv; p.last = sk.close[i]; }
        else if (lastDateOf.get(code)! < d && lastDateOf.get(code)! < endedBefore) { costF += (p.val * sellRate) / prevV; cash += p.val * (1 - sellRate); pos.delete(code); }
      }
      let now: Target | null = null, nowDate = d;
      if (delay) {
        if (pending) { now = pending; nowDate = pendingDate; pending = null; }
        if (execSet.has(d)) { pending = targetFn(d); pendingDate = d; }
      } else if (execSet.has(d)) now = targetFn(d);
      if (now) {
        const V = cash + [...pos.values()].reduce((a, p) => a + p.val, 0);
        const tg = new Map<string, number>();
        for (const [code, w] of now.w) if (byCode.get(code)!.idx.has(d) && w > 0) tg.set(code, w);
        let buyN = 0, sellN = 0;
        for (const [code, p] of pos) if (!tg.has(code)) sellN += p.val;
        for (const [code, w] of tg) { const diff = w * V - (pos.get(code)?.val ?? 0); if (diff > 0) buyN += diff; else sellN += -diff; }
        const C = buyN * buyRate + sellN * sellRate, scale = V > 0 ? (V - C) / V : 1;
        pos.clear();
        let inv = 0;
        for (const [code, w] of tg) { const sk = byCode.get(code)!; const val = w * V * scale; pos.set(code, { val, last: sk.close[sk.idx.get(d)!] }); inv += val; }
        cash = V - C - inv;
        costF += C / V;
        out.logs.push({ date: nowDate, nSel: now.meta?.nSel ?? 0, maxSel: now.meta?.maxSel ?? 0, maxAll: Math.max(0, ...tg.values()), nPos: tg.size, turnover: (buyN + sellN) / 2 / V, weights: new Map(tg) });
      }
      const V = cash + [...pos.values()].reduce((a, p) => a + p.val, 0);
      out.dates.push(d); out.ret.push((V / prevV - 1) * 100); out.costFrac.push(costF); out.contrib.push(dayContrib);
      prevV = V;
    }
    return out;
  }
  const execSetOf = (v: Variant): Set<string> => (v.c === 1 ? allMonthSet : v.d === 2 ? allMonthSet : quarterEnds);

  const endOfWin = (w: { to: string }): string => (w.to > TODAY ? TODAY : w.to);
  function stats(dates: string[], rets: number[], win: { from: string; to: string }, costFrac?: number[]) {
    const idx: number[] = [];
    for (let i = 0; i < dates.length; i++) if (dates[i] >= win.from && dates[i] <= win.to) idx.push(i);
    const r = idx.map((i) => rets[i]);
    const { totalReturnPct, mddPct } = computeCumulativeAndMdd(r);
    const cagr = computeCagrPct(totalReturnPct, win.from, endOfWin(win));
    const m = mean(r), sd = Math.sqrt(r.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(r.length - 1, 1));
    return { cagr, mdd: mddPct, cm: mddPct > 0 ? cagr / mddPct : NaN, vol: sd * Math.sqrt(252), cost: costFrac ? idx.reduce((a, i) => a + costFrac[i], 0) * 100 : NaN };
  }
  const turnoverM = (s: SimOut, win: { from: string; to: string }): number => s.logs.filter((l) => l.date >= win.from && l.date <= win.to).reduce((a, l) => a + l.turnover, 0) / monthEnds.filter((d) => d >= win.from && d <= win.to).length;

  // ---- 학습: 16개 + POOL + D4 (2018-12-31까지만) ----
  const variants: Variant[] = [];
  for (const a of [1, 2] as const) for (const b of [1, 2] as const) for (const c of [1, 2] as const) for (const d of [1, 2] as const) variants.push({ name: `A${a}B${b}C${c}D${d}`, a, K: b === 1 ? 15 : 30, c, d });
  const d4L = simulate(d4Target, allMonthSet, false, LEARN.to);
  const poolL = simulate(poolTarget, allMonthSet, false, LEARN.to);
  const sD4 = stats(d4L.dates, d4L.ret, LEARN, d4L.costFrac), sPool = stats(poolL.dates, poolL.ret, LEARN, poolL.costFrac);
  const res = variants.map((v) => {
    const sim = simulate(makeTarget(v), execSetOf(v), false, LEARN.to);
    const s = stats(sim.dates, sim.ret, LEARN, sim.costFrac);
    const tm = turnoverM(sim, LEARN);
    const qual = s.cagr > sPool.cagr && s.mdd <= sPool.mdd + QUAL_MDD_MARGIN;
    return { v, s, tm, qual };
  });
  console.log("\n=== (b) 학습 구간(2012-04-01~2018-12-31) 16개 변형 ===");
  console.log("| 변형 | CAGR % | MDD % | CAGR÷MDD | 연변동성 % | 월평균 회전율 % | 누적 비용 % | 자격 |\n|---|---|---|---|---|---|---|---|");
  for (const r of res) console.log(`| ${r.v.name} | ${f2(r.s.cagr)} | ${f2(r.s.mdd)} | ${f2(r.s.cm)} | ${f2(r.s.vol)} | ${f2(r.tm * 100)} | ${f2(r.s.cost)} | ${ox(r.qual)} |`);
  console.log(`| POOL | ${f2(sPool.cagr)} | ${f2(sPool.mdd)} | ${f2(sPool.cm)} | ${f2(sPool.vol)} | - | ${f2(sPool.cost)} | - |`);
  console.log(`| D4 | ${f2(sD4.cagr)} | ${f2(sD4.mdd)} | ${f2(sD4.cm)} | ${f2(sD4.vol)} | - | ${f2(sD4.cost)} | - |`);
  const l0 = res.find((r) => r.v.name === "A1B1C1D1")!;
  console.log(`원안(L0) = A1B1C1D1: ${f2(l0.s.cagr)} / ${f2(l0.s.mdd)} / ${f2(l0.s.cm)} / ${f2(l0.s.vol)} / 비용 ${f2(l0.s.cost)} (이전 실행 2e747e3 학습: -1.73 / 34.41 / -0.05 / 19.71 / 11.58)`);
  console.log(`자격 기준: 학습 CAGR > POOL ${f2(sPool.cagr)} 그리고 학습 MDD ≤ POOL ${f2(sPool.mdd)} + ${QUAL_MDD_MARGIN}`);

  // ---- 선택 ----
  const qualified = res.filter((r) => r.qual).sort((a, b) => (b.s.cm - a.s.cm) || (a.tm - b.tm));
  console.log("\n=== (c) 선택 결과 ===");
  if (!qualified.length) {
    console.log("선택 없음 (자격 있는 변형 0개) — 확인 계산을 하지 않고 종료합니다.");
  } else {
    const best = qualified[0];
    console.log(`자격 있는 변형 ${qualified.length}개: ${qualified.map((r) => `${r.v.name}(${f2(r.s.cm)})`).join(", ")} → 선택: ${best.v.name}`);
    const v = best.v;
    const full = simulate(makeTarget(v), execSetOf(v), false, "9999-12-31");
    const dly = simulate(makeTarget(v), execSetOf(v), true, "9999-12-31");
    const d4F = simulate(d4Target, allMonthSet, false, "9999-12-31");
    const poolF = simulate(poolTarget, allMonthSet, false, "9999-12-31");
    const ew = simulateUniverseMonthlyRebalance(pricesByStock, CAL, PERIOD_START, (code, date) => { const sk = byCode.get(code)!; const i = sk.idx.get(date); return i !== undefined && Number.isFinite(sk.avgTv[i]) && sk.mcap[i] >= CAP_EOK && sk.avgTv[i] >= PIT_MIN_AVG_TRADING_VALUE_WON; }, true);
    const kospiRaw = await getIndexPriceSeries("KOSPI", PERIOD_START, TODAY);
    dbRead["beta_price_history(KOSPI)"] = kospiRaw.length;
    const kp = kospiRaw.filter((p) => p.tradeDate >= PERIOD_START);
    const kDates = kp.slice(1).map((p) => p.tradeDate);
    const kRets = computeIndexDailyReturnsPct(kp as never);
    const rowsDef: [string, string[], number[], number[] | undefined][] = [[v.name, full.dates, full.ret, full.costFrac], ["D4", d4F.dates, d4F.ret, d4F.costFrac], ["POOL", poolF.dates, poolF.ret, poolF.costFrac], ["KOSPI", kDates, kRets, undefined], ["유니버스 동일가중", CAL, ew, undefined]];
    console.log("\n=== (d) 선택 변형의 확인(2019-01-01~)·전체(2012-04~)·학습 표 ===");
    console.log("| 기간 | 구성 | CAGR % | MDD % | CAGR÷MDD | 연변동성 % | 누적 거래비용 % |\n|---|---|---|---|---|---|---|");
    const S: Record<string, Record<string, ReturnType<typeof stats>>> = { 확인: {}, 전체: {} };
    for (const [wn, win] of [["확인", CONFIRM], ["전체", FULL]] as const) for (const [lab, dd, rr, cc] of rowsDef) {
      const s = stats(dd, rr, win, cc); S[wn][lab] = s;
      console.log(`| ${wn} | ${lab === v.name ? `선택(${v.name})` : lab} | ${f2(s.cagr)} | ${f2(s.mdd)} | ${f2(s.cm)} | ${f2(s.vol)} | ${Number.isFinite(s.cost) ? f2(s.cost) : "-"} |`);
    }
    const dC = stats(dly.dates, dly.ret, CONFIRM, dly.costFrac);
    const a = S.확인[v.name], b = S.확인["D4"], p = S.확인["POOL"];
    const crit: [string, string, string, boolean][] = [
      ["C1", `${f2(a.cagr)} vs D4 ${f2(b.cagr)}`, "CAGR > D4", a.cagr > b.cagr],
      ["C2", `${f2(a.mdd)} vs D4 ${f2(b.mdd)} + ${C2_MARGIN}`, "MDD ≤ D4 MDD + 5.0%p", a.mdd <= b.mdd + C2_MARGIN],
      ["C3", `${f2(a.cm)} vs D4 ${f2(b.cm)}`, "CAGR÷MDD > D4", a.cm > b.cm],
      ["C4", `${f2(a.cagr)} vs POOL ${f2(p.cagr)}`, "CAGR > POOL", a.cagr > p.cagr],
      ["C5", `지연 없음 ${f2(a.cagr)} − 지연 ${f2(dC.cagr)} = ${f2(a.cagr - dC.cagr)}%p`, "하락 ≤ 1.0%p", a.cagr - dC.cagr <= C5_MAX_DROP],
    ];
    console.log("\n확인 구간 판정 (선택된 1개)");
    console.log("| 항목 | 측정값 | 기준 | 결과 |\n|---|---|---|---|");
    for (const [k, m, r, ok] of crit) console.log(`| ${k} | ${m} | ${r} | ${ox(ok)} |`);
    console.log(`전부 O(통과 표시): ${ox(crit.every((c) => c[3]))}`);
    console.log(`지연 +1일: 확인 CAGR ${f2(dC.cagr)} / MDD ${f2(dC.mdd)} / CAGR÷MDD ${f2(dC.cm)}`);

    console.log("\n=== (e) 선택 변형 상세 ===");
    const years: number[] = [];
    for (let y = 2012; y <= Number(TODAY.slice(0, 4)); y++) years.push(y);
    const yret = (dd: string[], rr: number[], y: number): number => computeCumulativeAndMdd(rr.filter((_, i) => dd[i].startsWith(`${y}-`) && dd[i] >= "2012-04-01")).totalReturnPct;
    console.log("| 구성 | " + years.join(" | ") + " |\n|---|" + years.map(() => "---").join("|") + "|");
    for (const [lab, dd, rr] of [[v.name, full.dates, full.ret], ["D4", d4F.dates, d4F.ret], ["POOL", poolF.dates, poolF.ret], ["KOSPI", kDates, kRets]] as [string, string[], number[]][]) console.log(`| ${lab} | ${years.map((y) => f2(yret(dd, rr, y))).join(" | ")} |`);
    const contribSum = new Map<string, number>();
    for (let i = 0; i < full.dates.length; i++) if (full.dates[i] >= "2012-04-01") for (const [c, x] of full.contrib[i]) contribSum.set(c, (contribSum.get(c) ?? 0) + x);
    const top5 = [...contribSum.entries()].sort((x, y) => y[1] - x[1]).slice(0, 5);
    console.log("\n기여 상위 5종목");
    console.log("| 종목 | 보유 개월 수(실행 직후 비중>0, 실행 횟수 기준) | 기여 %p |\n|---|---|---|");
    for (const [c, x] of top5) console.log(`| ${c} | ${full.logs.filter((l) => (l.weights.get(c) ?? 0) > 0).length} | ${f2(x * 100)} |`);
    const t5 = new Set(top5.map(([c]) => c));
    const exRet = full.ret.map((r, i) => r - [...t5].reduce((acc, c) => acc + (full.contrib[i].get(c) ?? 0) * 100, 0));
    const exS = stats(full.dates, exRet, FULL);
    console.log(`상위 5종목 제외 전체 CAGR ${f2(exS.cagr)}% (제외 전 ${f2(S.전체[v.name].cagr)}%), MDD ${f2(exS.mdd)}%`);
    console.log(`평균 보유 종목 수(실행 직후 비중>0, D4 바스켓 포함) ${f2(mean(full.logs.map((l) => l.nPos)))} | 평균 선정(통과 선정/×2) 수 ${f2(mean(full.logs.map((l) => l.nSel)))} | 최대 단일 비중(합산) ${f2(Math.max(...full.logs.map((l) => l.maxAll)) * 100)}% | 선정 종목만 ${f2(Math.max(...full.logs.map((l) => l.maxSel)) * 100)}% | 실행 ${full.logs.length}회`);
  }

  console.log("\n=== (f) 실행 지표 ===");
  console.log(`Supabase 읽은 행: ${Object.entries(dbRead).map(([k, x]) => `${k} ${x}`).join(" | ")} | 합계 ${Object.values(dbRead).reduce((a, x) => a + x, 0)}`);
  console.log(`Supabase 쓴 행: 0 | 외부 요청(DART/KIS 등): 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
}
main().catch((e) => { console.error(e); process.exit(1); });
