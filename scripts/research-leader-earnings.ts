/**
 * [임시 연구 — 병합 금지, 읽기 전용, 외부 요청 0건] 신규 전략 "이익이 붙는 대형 주도주"(T71) 학습/확인 1회.
 * 사전 등록: research/leader-earnings-prereg.md (커밋 2e747e3). 정의·기준은 그 문서가 고정한다. 숫자와 표, O/X만 출력한다.
 */
import { getIndexPriceSeries } from "@/lib/betaPriceHistoryStorage";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadAllStockSeriesFromParquet } from "@/lib/stockDailyPricesStorage";
import { loadAppliedAdjustments } from "@/lib/stockPriceAdjustmentsStorage";
import { computeTrailingAvgTradingValue } from "@/lib/pitUniverse";
import { PIT_LIQUIDITY_LOOKBACK_DAYS, PIT_MIN_AVG_TRADING_VALUE_WON } from "@/lib/strategyBacktestSummaryConfig";
import { computeCumulativeAndMdd, computeCagrPct } from "@/lib/strategyBacktestSummary";
import { computeIndexDailyReturnsPct, simulateUniverseMonthlyRebalance, computeMonthlyRebalanceDates } from "@/lib/benchmarkSummary";
import { computeEffectiveBuyPrice, computeEffectiveSellPrice } from "@/lib/transactionCost";
import { FIN_NAME_RE } from "@/lib/dartXbrlBackfillConfig";
import { PERIOD_START, TODAY, CAP_EOK } from "./research-ma-lab";
import type { Sk } from "./research-audit-peg";

const T0 = Date.now();
const POOL_SIZE = 100, MOM_LONG = 252, MOM_SHORT = 21, CAND_N = 30, SEL_MAX = 15, W_CAP = 0.2, FULL_N = 5;
const START_MONTH = "2012-03";
const WIN = { 학습: { from: "2012-04-01", to: "2018-12-31" }, 확인: { from: "2019-01-01", to: "9999-12-31" }, 전체: { from: "2012-04-01", to: "9999-12-31" } } as const;
type WK = keyof typeof WIN;
const WKS: WK[] = ["학습", "확인", "전체"];
const C2_MARGIN = 5.0, C5_MAX_DROP = 1.0;
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
type Cand = { code: string; status: "ok" | "missing" | "fail" };
interface TargetMeta { nSel: number; total: number; maxSel: number; maxAll: number; cands: Cand[] }
interface Target { w: Map<string, number>; meta?: TargetMeta }
interface RebalLog { date: string; nSel: number; total: number; maxSel: number; maxAll: number; turnover: number; weights: Map<string, number>; cands: Cand[] }
interface SimOut { dates: string[]; ret: number[]; costFrac: number[]; logs: RebalLog[]; contrib: Map<string, number>[] }

async function main(): Promise<void> {
  console.log(`이익이 붙는 대형 주도주(T71) 학습/확인 시작(읽기 전용): ${new Date().toISOString()} (사전등록 2e747e3 이후)`);
  const adjustments = await loadAppliedAdjustments();
  dbRead["stock_price_adjustment_events(applied)"] = [...adjustments.values()].reduce((a, l) => a + l.length, 0);
  const series = await loadAllStockSeriesFromParquet(2010, new Date().getUTCFullYear(), adjustments);
  const kospiRaw = await getIndexPriceSeries("KOSPI", PERIOD_START, TODAY);
  dbRead["beta_price_history(KOSPI)"] = kospiRaw.length;
  const funds = await selectAll<{ stock_code: string; fiscal_year: number; rcept_date: string; net_income_parent: number | null; fs_div: string }>("stock_annual_fundamentals", (f, t) => supabaseAdmin.from("stock_annual_fundamentals").select("stock_code, fiscal_year, rcept_date, net_income_parent, fs_div").order("stock_code").order("fiscal_year").range(f, t));
  const fundBy = new Map<string, FRow[]>();
  for (const r of funds) fundBy.set(r.stock_code, [...(fundBy.get(r.stock_code) ?? []), { fy: r.fiscal_year, rcept: r.rcept_date, ni: r.net_income_parent === null ? null : Number(r.net_income_parent), fs: r.fs_div }]);

  // ---- 종목 배열 ----
  const calSet = new Set<string>();
  let globalLast = "";
  const stocks: Sk[] = [];
  const lastDateOf = new Map<string, string>();
  const pricesByStock = new Map<string, { date: string; close: number }[]>();
  const liquidity = new Map<string, Map<string, number>>();
  for (const [code, rows] of series) {
    for (const r of rows) if (r.tradeDate >= PERIOD_START) calSet.add(r.tradeDate);
    const l = rows[rows.length - 1].tradeDate;
    if (l > globalLast) globalLast = l;
    lastDateOf.set(code, l);
    const avgTv = computeTrailingAvgTradingValue(rows, PIT_LIQUIDITY_LOOKBACK_DAYS);
    stocks.push({ code, dates: rows.map((r) => r.tradeDate), close: Float64Array.from(rows.map((r) => r.closePrice)), mcap: Float64Array.from(rows.map((r) => r.marketCapEok)), avgTv, idx: new Map(rows.map((r, i) => [r.tradeDate, i])) });
    pricesByStock.set(code, rows.map((r) => ({ date: r.tradeDate, close: r.closePrice })));
  }
  const CAL = [...calSet].sort();
  const rebalanceDates = computeMonthlyRebalanceDates(CAL);
  for (const sk of stocks) {
    const lq = new Map<string, number>();
    for (const d of rebalanceDates) { const i = sk.idx.get(d); if (i !== undefined && Number.isFinite(sk.avgTv[i]) && sk.mcap[i] >= CAP_EOK) lq.set(d, sk.avgTv[i]); }
    liquidity.set(sk.code, lq);
  }
  const monthEndSet = new Set<string>();
  for (let k = 0; k + 1 < CAL.length; k++) if (CAL[k].slice(0, 7) !== CAL[k + 1].slice(0, 7)) monthEndSet.add(CAL[k]);
  const rebalDates = [...monthEndSet].sort().filter((d) => d.slice(0, 7) >= START_MONTH);
  const rebalSet = new Set(rebalDates);
  const startD = rebalDates[0];
  const endedBefore = new Date(Date.parse(globalLast) - ENDED_GRACE_DAYS * MS_DAY).toISOString().slice(0, 10);
  console.log(`종목 ${stocks.length}개, 거래일 ${CAL.length}일, 데이터 끝 ${globalLast}, 첫 리밸런스 ${startD}, 리밸런스 ${rebalDates.length}회(마지막 ${rebalDates[rebalDates.length - 1]})`);
  const byCode = new Map(stocks.map((s) => [s.code, s]));
  const buyRate = computeEffectiveBuyPrice(1) - 1;

  // ---- 목표 비중 ----
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
  const d4Target = (d: string): Target => {
    const el = eligibleAt(d);
    const tot = el.reduce((a, x) => a + x.mcap, 0);
    return { w: new Map(el.map((x) => [x.sk.code, x.mcap / tot])) };
  };
  const poolTarget = (d: string): Target => {
    const pool = eligibleAt(d).sort(byMcap).slice(0, POOL_SIZE);
    const tot = pool.reduce((a, x) => a + x.mcap, 0);
    return { w: new Map(pool.map((x) => [x.sk.code, x.mcap / tot])) };
  };
  const earnings = (code: string, d: string): "ok" | "missing" | "fail" => {
    const vis = (fundBy.get(code) ?? []).filter((r) => r.rcept <= d);
    if (!vis.length) return "missing";
    const E = Math.max(...vis.map((r) => r.fy));
    const cur = vis.find((r) => r.fy === E), prev = vis.find((r) => r.fy === E - 1);
    if (!cur || !prev || cur.ni === null || prev.ni === null) return "missing";
    if (cur.fs !== prev.fs) return "fail";
    return cur.ni > 0 && cur.ni > prev.ni ? "ok" : "fail";
  };
  const strategyTarget = (d: string): Target => {
    const el = eligibleAt(d);
    const pool = [...el].sort(byMcap).slice(0, POOL_SIZE);
    const moms = pool.filter((x) => x.i >= MOM_LONG).map((x) => ({ x, mom: x.sk.close[x.i - MOM_SHORT] / x.sk.close[x.i - MOM_LONG] - 1 })).filter((m) => Number.isFinite(m.mom));
    moms.sort((a, b) => b.mom - a.mom || (a.x.sk.code < b.x.sk.code ? -1 : 1));
    const cands = moms.slice(0, CAND_N);
    const candInfo: Cand[] = [];
    const sel: El[] = [];
    for (const c of cands) {
      const st = earnings(c.x.sk.code, d);
      candInfo.push({ code: c.x.sk.code, status: st });
      if (st === "ok" && sel.length < SEL_MAX) sel.push(c.x);
    }
    const n = sel.length;
    const total = n === 0 ? 0 : n >= FULL_N ? 1 : n * W_CAP;
    const selW = n ? capWeights(sel.map((x) => ({ code: x.sk.code, m: x.mcap })), total) : new Map<string, number>();
    const w = new Map(selW);
    const totM = el.reduce((a, x) => a + x.mcap, 0);
    if (total < 1) for (const x of el) w.set(x.sk.code, (w.get(x.sk.code) ?? 0) + ((1 - total) * x.mcap) / totM);
    return { w, meta: { nSel: n, total, maxSel: n ? Math.max(...selW.values()) : 0, maxAll: Math.max(...w.values()), cands: candInfo } };
  };

  // ---- 엔진 ----
  function simulate(targetFn: (d: string) => Target, delay: boolean): SimOut {
    let cash = 1, prevV = 1;
    const pos = new Map<string, { val: number; last: number }>();
    const out: SimOut = { dates: [], ret: [], costFrac: [], logs: [], contrib: [] };
    let pending: Target | null = null, pendingDate = "";
    for (const d of CAL) {
      if (d < startD) continue;
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
        if (rebalSet.has(d)) { pending = targetFn(d); pendingDate = d; }
      } else if (rebalSet.has(d)) now = targetFn(d);
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
        const m = now.meta;
        out.logs.push({ date: nowDate, nSel: m?.nSel ?? 0, total: m?.total ?? 0, maxSel: m?.maxSel ?? 0, maxAll: Math.max(0, ...tg.values()), turnover: (buyN + sellN) / 2 / V, weights: new Map(tg), cands: m?.cands ?? [] });
      }
      const V = cash + [...pos.values()].reduce((a, p) => a + p.val, 0);
      out.dates.push(d); out.ret.push((V / prevV - 1) * 100); out.costFrac.push(costF); out.contrib.push(dayContrib);
      prevV = V;
    }
    return out;
  }

  console.log("시뮬레이션: 전략, D4, POOL, 전략(+1일 지연)");
  const strat = simulate(strategyTarget, false);
  const d4 = simulate(d4Target, false);
  const pool = simulate(poolTarget, false);
  const stratDelay = simulate(strategyTarget, true);
  const ew = simulateUniverseMonthlyRebalance(pricesByStock, CAL, PERIOD_START, (code, date) => (liquidity.get(code)?.get(date) ?? NaN) >= PIT_MIN_AVG_TRADING_VALUE_WON, true);
  const kp = kospiRaw.filter((p) => p.tradeDate >= PERIOD_START);
  const kDates = kp.slice(1).map((p) => p.tradeDate);
  const kRets = computeIndexDailyReturnsPct(kp as never);

  // ---- 지표 ----
  const endOf = (w: WK): string => (WIN[w].to > TODAY ? TODAY : WIN[w].to);
  function stats(dates: string[], rets: number[], w: WK, costFrac?: number[]) {
    const idx: number[] = [];
    for (let i = 0; i < dates.length; i++) if (dates[i] >= WIN[w].from && dates[i] <= WIN[w].to) idx.push(i);
    const r = idx.map((i) => rets[i]);
    const { totalReturnPct, mddPct } = computeCumulativeAndMdd(r);
    const cagr = computeCagrPct(totalReturnPct, WIN[w].from, endOf(w));
    const m = mean(r), sd = Math.sqrt(r.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(r.length - 1, 1));
    return { cagr, mdd: mddPct, cm: mddPct > 0 ? cagr / mddPct : NaN, vol: sd * Math.sqrt(252), cost: costFrac ? idx.reduce((a, i) => a + costFrac[i], 0) * 100 : NaN };
  }
  const rows: [string, string[], number[], number[] | undefined][] = [["전략", strat.dates, strat.ret, strat.costFrac], ["D4", d4.dates, d4.ret, d4.costFrac], ["POOL(시총 상위 100)", pool.dates, pool.ret, pool.costFrac], ["KOSPI", kDates, kRets, undefined], ["유니버스 동일가중", CAL, ew, undefined]];
  const S: Record<WK, Record<string, ReturnType<typeof stats>>> = { 학습: {}, 확인: {}, 전체: {} };
  console.log("\n=== (b) 기간 × 구성 ===");
  console.log("| 기간 | 구성 | CAGR % | MDD % | CAGR÷MDD | 연변동성 % | 누적 거래비용 % |\n|---|---|---|---|---|---|---|");
  for (const w of WKS) for (const [lab, d, r, c] of rows) {
    const s = stats(d, r, w, c); S[w][lab] = s;
    console.log(`| ${w} | ${lab} | ${f2(s.cagr)} | ${f2(s.mdd)} | ${f2(s.cm)} | ${f2(s.vol)} | ${Number.isFinite(s.cost) ? f2(s.cost) : "-"} |`);
  }
  const dl: Record<WK, ReturnType<typeof stats>> = { 학습: stats(stratDelay.dates, stratDelay.ret, "학습", stratDelay.costFrac), 확인: stats(stratDelay.dates, stratDelay.ret, "확인", stratDelay.costFrac), 전체: stats(stratDelay.dates, stratDelay.ret, "전체", stratDelay.costFrac) };

  // ---- (c) ----
  console.log("\n=== (c) 사전 판정 기준 (O/X) ===");
  console.log("| 기간 | 항목 | 측정값 | 기준 | 결과 |\n|---|---|---|---|---|");
  const allO: Record<string, boolean> = {};
  for (const w of ["학습", "확인"] as WK[]) {
    const a = S[w]["전략"], b = S[w]["D4"], p = S[w]["POOL(시총 상위 100)"];
    const res: [string, string, string, boolean][] = [
      ["C1", `전략 ${f2(a.cagr)} vs D4 ${f2(b.cagr)}`, "CAGR > D4", a.cagr > b.cagr],
      ["C2", `전략 ${f2(a.mdd)} vs D4 ${f2(b.mdd)}+${C2_MARGIN}`, "MDD ≤ D4 MDD + 5.0%p", a.mdd <= b.mdd + C2_MARGIN],
      ["C3", `전략 ${f2(a.cm)} vs D4 ${f2(b.cm)}`, "CAGR÷MDD > D4", a.cm > b.cm],
      ["C4", `전략 ${f2(a.cagr)} vs POOL ${f2(p.cagr)}`, "CAGR > POOL", a.cagr > p.cagr],
    ];
    if (w === "확인") res.push(["C5", `지연 없음 ${f2(a.cagr)} − 지연 ${f2(dl[w].cagr)} = ${f2(a.cagr - dl[w].cagr)}%p`, "하락 ≤ 1.0%p", a.cagr - dl[w].cagr <= C5_MAX_DROP]);
    for (const [k, v, rule, ok] of res) { console.log(`| ${w} | ${k} | ${v} | ${rule} | ${ox(ok)} |`); allO[`${w}${k}`] = ok; }
  }
  console.log(`학습 C1~C4 전부 O: ${ox(["C1", "C2", "C3", "C4"].every((k) => allO[`학습${k}`]))} | 확인 C1~C5 전부 O: ${ox(["C1", "C2", "C3", "C4", "C5"].every((k) => allO[`확인${k}`]))} | 둘 다 전부 O(통과 표시): ${ox(Object.values(allO).every(Boolean))}`);

  // ---- (d) 연도별 ----
  console.log("\n=== (d) 연도별 수익률 % (2012는 4월~) ===");
  const years: number[] = [];
  for (let y = 2012; y <= Number(TODAY.slice(0, 4)); y++) years.push(y);
  const yret = (dates: string[], rets: number[], y: number): number => computeCumulativeAndMdd(rets.filter((_, i) => dates[i].startsWith(`${y}-`) && dates[i] >= "2012-04-01")).totalReturnPct;
  console.log("| 구성 | " + years.join(" | ") + " |\n|---|" + years.map(() => "---").join("|") + "|");
  for (const [lab, d, r] of [["전략", strat.dates, strat.ret], ["D4", d4.dates, d4.ret], ["POOL", pool.dates, pool.ret], ["KOSPI", kDates, kRets]] as [string, string[], number[]][]) console.log(`| ${lab} | ${years.map((y) => f2(yret(d, r, y))).join(" | ")} |`);

  // ---- (e) ----
  const logs = strat.logs;
  const nSels = logs.map((l) => l.nSel);
  const sub = logs.filter((l) => l.nSel < FULL_N);
  console.log("\n=== (e) 선정·비중·회전 (전체 경로 리밸런스 월 기준) ===");
  console.log(`리밸런스 ${logs.length}회: 월별 선정 종목 수 평균 ${f2(mean(nSels))} / 최소 ${Math.min(...nSels)} / 최대 ${Math.max(...nSels)}`);
  console.log(`D4 대체 비중이 있었던 월(선정 수<5) ${sub.length}개월, 그 달들의 평균 대체 비중 ${f2(mean(sub.map((l) => (1 - l.total) * 100)))}% (선정 0개 월 ${logs.filter((l) => l.nSel === 0).length})`);
  console.log(`최대 단일 종목 비중: 합산(D4 바스켓 포함) ${f2(Math.max(...logs.map((l) => l.maxAll)) * 100)}% | 선정 종목만 ${f2(Math.max(...logs.map((l) => l.maxSel)) * 100)}%`);
  console.log(`월평균 회전율(첫 리밸런스 제외): ${f2(mean(logs.slice(1).map((l) => l.turnover)) * 100)}%`);

  // ---- (f) ----
  const contribSum = new Map<string, number>();
  for (let i = 0; i < strat.dates.length; i++) if (strat.dates[i] >= "2012-04-01") for (const [c, v] of strat.contrib[i]) contribSum.set(c, (contribSum.get(c) ?? 0) + v);
  const top5 = [...contribSum.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  console.log("\n=== (f) 전체 기간 기여 상위 5종목 ===");
  console.log("| 종목 | 보유 개월 수(목표 비중>0) | 기여 %p |\n|---|---|---|");
  for (const [c, v] of top5) console.log(`| ${c} | ${logs.filter((l) => (l.weights.get(c) ?? 0) > 0).length} | ${f2(v * 100)} |`);
  const top5Set = new Set(top5.map(([c]) => c));
  const exRet = strat.ret.map((r, i) => r - [...top5Set].reduce((a, c) => a + (strat.contrib[i].get(c) ?? 0) * 100, 0));
  const exS = stats(strat.dates, exRet, "전체");
  console.log(`상위 5종목 제외 전체 CAGR ${f2(exS.cagr)}% (제외 전 ${f2(S.전체["전략"].cagr)}%), MDD ${f2(exS.mdd)}%`);

  // ---- (g) ----
  const evalBy = new Map<number, { total: number; missing: number; missingCodes: string[] }>();
  for (const l of logs) {
    const y = Number(l.date.slice(0, 4));
    const e = evalBy.get(y) ?? evalBy.set(y, { total: 0, missing: 0, missingCodes: [] }).get(y)!;
    for (const c of l.cands) { e.total++; if (c.status === "missing") { e.missing++; e.missingCodes.push(c.code); } }
  }
  const allMissing = [...new Set([...evalBy.values()].flatMap((e) => e.missingCodes))];
  const nameOf = new Map<string, string>();
  for (let i = 0; i < allMissing.length; i += 200) {
    const chunk = allMissing.slice(i, i + 200);
    const rs = await selectAll<{ stock_code: string | null; corp_name: string }>("dart_corp_codes", (f, t) => supabaseAdmin.from("dart_corp_codes").select("stock_code, corp_name").in("stock_code", chunk).order("corp_code").range(f, t));
    for (const r of rs) if (r.stock_code && !nameOf.has(r.stock_code)) nameOf.set(r.stock_code, r.corp_name);
  }
  console.log("\n=== (g) 이익 확인 단계 '재무 행 없음' 탈락 (후보 평가 건수 대비, 연도별) ===");
  console.log("| 연도 | 후보 평가 건수 | 재무 행 없음 탈락 | 비율 | 그중 금융업(이름 기준) | 금융업 비율 | 이름 불명 |\n|---|---|---|---|---|---|---|");
  let gt = 0, gm = 0, gf = 0, gu = 0;
  for (const y of [...evalBy.keys()].sort()) {
    const e = evalBy.get(y)!;
    const fin = e.missingCodes.filter((c) => FIN_NAME_RE.test(nameOf.get(c) ?? "")).length, unk = e.missingCodes.filter((c) => !nameOf.has(c)).length;
    gt += e.total; gm += e.missing; gf += fin; gu += unk;
    console.log(`| ${y} | ${e.total} | ${e.missing} | ${e.total ? ((e.missing / e.total) * 100).toFixed(1) : "-"}% | ${fin} | ${e.missing ? ((fin / e.missing) * 100).toFixed(1) : "-"}% | ${unk} |`);
  }
  console.log(`| 합계 | ${gt} | ${gm} | ${gt ? ((gm / gt) * 100).toFixed(1) : "-"}% | ${gf} | ${gm ? ((gf / gm) * 100).toFixed(1) : "-"}% | ${gu} |`);

  // ---- (h) ----
  console.log("\n=== (h) +1거래일 지연 ===");
  console.log("| 기간 | 구성 | CAGR % | MDD % | CAGR÷MDD | 연변동성 % | 누적 거래비용 % |\n|---|---|---|---|---|---|---|");
  for (const w of WKS) { console.log(`| ${w} | 전략(지연 없음) | ${f2(S[w]["전략"].cagr)} | ${f2(S[w]["전략"].mdd)} | ${f2(S[w]["전략"].cm)} | ${f2(S[w]["전략"].vol)} | ${f2(S[w]["전략"].cost)} |`); console.log(`| ${w} | 전략(+1일 지연) | ${f2(dl[w].cagr)} | ${f2(dl[w].mdd)} | ${f2(dl[w].cm)} | ${f2(dl[w].vol)} | ${f2(dl[w].cost)} |`); }

  console.log("\n=== (i) 실행 지표 ===");
  console.log(`Supabase 읽은 행: ${Object.entries(dbRead).map(([k, v]) => `${k} ${v}`).join(" | ")} | 합계 ${Object.values(dbRead).reduce((a, b) => a + b, 0)}`);
  console.log(`Supabase 쓴 행: 0 | 외부 요청(DART/KIS 등): 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
}
main().catch((e) => { console.error(e); process.exit(1); });
