/**
 * [임시 연구 — 병합 금지, 읽기 전용, 외부 요청 0건] 시총가중(D4) + 이동평균 추세 전략 6종 (T88~93).
 * 사전 등록: research/trend-capweight-prereg.md (커밋 2849f8b). 정의·기준은 그 문서가 고정한다. 숫자와 표, O/X만 출력한다.
 */
import { getIndexPriceSeries } from "@/lib/betaPriceHistoryStorage";
import { loadAllStockSeriesFromParquet } from "@/lib/stockDailyPricesStorage";
import { loadAppliedAdjustments } from "@/lib/stockPriceAdjustmentsStorage";
import { STOCK_DATA_EARLIEST_YEAR, STRATEGY_BACKTEST_PRICE_FETCH_LOOKBACK_YEARS, PIT_MIN_AVG_TRADING_VALUE_WON } from "@/lib/strategyBacktestSummaryConfig";
import { accumulateStockDailyReturns, computeCumulativeAndMdd, computeCagrPct, type DailyStockReturns } from "@/lib/strategyBacktestSummary";
import { computeIndexDailyReturnsPct, simulateUniverseMonthlyRebalance } from "@/lib/benchmarkSummary";
import { computeEffectiveBuyPrice, computeEffectiveSellPrice } from "@/lib/transactionCost";
import { buildCtx, genTrades, PERIOD_START, TODAY, CAP_EOK, type Ctx } from "./research-ma-lab";
import { simulateD4, type Sk } from "./research-audit-peg";

const T0 = Date.now();
const NS = [224, 200] as const;
const KINDS = ["T1", "T2", "T3"] as const;
type CandKind = (typeof KINDS)[number];
const POOL_SIZE = 100;
const LEARN_END = "2018-12-31", CONFIRM_START = "2019-01-01";
const TR_CAGR_MARGIN = 2.0, TR_MDD_RATIO = 0.8, CF4_MAX_DROP = 1.0;
const ENDED_GRACE_DAYS = 14;
const NEAR_HIGH_MIN_GAP = -0.1829, NEAR_HIGH_BARS = 252;
const EXPECT_V3 = { cagr: "6.36", mdd: "53.31", trades: 2335 };
const MS_DAY = 86_400_000;
const CURRENT_YEAR = new Date().getUTCFullYear();
const FETCH_START = Math.max(STOCK_DATA_EARLIEST_YEAR, Number(PERIOD_START.slice(0, 4)) - STRATEGY_BACKTEST_PRICE_FETCH_LOOKBACK_YEARS);
const f2 = (x: number): string => (Number.isFinite(x) ? x.toFixed(2) : "-");
const ox = (b: boolean): string => (b ? "O" : "X");
const dayDiff = (a: string, b: string): number => (Date.parse(b) - Date.parse(a)) / MS_DAY;
const dbRead: Record<string, number> = {};

interface TR { buyDate: string; sellDate: string; ret: number; days: { d: string; r: number }[] }
interface Win { from: string; to: string }
interface Out { dates: string[]; ret: number[]; costFrac: number[]; turn: { d: string; v: number }[]; sw: { d: string; n: number }[] }
interface Sig { d: string; flag: boolean; full: boolean; P: Set<string>; w: Map<string, number> }

function nearHighOk(ctx: Ctx, e: number): boolean {
  let hi = -Infinity;
  for (let j = Math.max(0, e - (NEAR_HIGH_BARS - 1)); j <= e; j++) if (ctx.prices[j].high > hi) hi = ctx.prices[j].high;
  return ctx.prices[e].close / hi - 1 > NEAR_HIGH_MIN_GAP;
}
const byCodeAsc = (a: { code: string }, b: { code: string }): number => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);

async function main(): Promise<void> {
  console.log(`시총가중+추세 6종(T88~93) 시작(읽기 전용): ${new Date().toISOString()} (사전등록 2849f8b 이후)`);
  const adjustments = await loadAppliedAdjustments();
  dbRead["stock_price_adjustment_events(applied)"] = [...adjustments.values()].reduce((a, l) => a + l.length, 0);
  const series = await loadAllStockSeriesFromParquet(FETCH_START, CURRENT_YEAR, adjustments);
  console.log(`종목 ${series.size}개 로드, heap ${(process.memoryUsage().heapUsed / 1048576).toFixed(0)}MB`);
  const kospi = await getIndexPriceSeries("KOSPI", "2008-01-01", TODAY);
  dbRead["beta_price_history(KOSPI)"] = kospi.length;

  // ---- 종목 구조(기준선 분해 진단과 동일) + v3 거래 ----
  const calSet = new Set<string>();
  for (const rows of series.values()) for (const r of rows) calSet.add(r.tradeDate);
  const cal = [...calSet].sort();
  const CALF = cal.filter((d) => d >= PERIOD_START);
  const stocks: Sk[] = [];
  const pricesByStock = new Map<string, { date: string; close: number }[]>();
  const liquidity = new Map<string, Map<string, number>>();
  const monthEndSet = new Set<string>();
  for (let k = 0; k + 1 < CALF.length; k++) if (CALF[k].slice(0, 7) !== CALF[k + 1].slice(0, 7)) monthEndSet.add(CALF[k]);
  const v3: TR[] = [];
  for (const [code, rows] of series) {
    const ctx = buildCtx(code, rows);
    series.delete(code);
    const sk: Sk = { code, dates: ctx.prices.map((p) => p.date), close: Float64Array.from(ctx.closes), mcap: Float64Array.from(rows.map((r) => r.marketCapEok)), avgTv: ctx.avgTv, idx: new Map(ctx.prices.map((p, i) => [p.date, i])) };
    stocks.push(sk);
    pricesByStock.set(code, ctx.prices.map((p) => ({ date: p.date, close: p.close })));
    const lq = new Map<string, number>();
    for (const d of monthEndSet) {
      const i = sk.idx.get(d);
      if (i !== undefined && Number.isFinite(ctx.avgTv[i]) && rows[i].marketCapEok >= CAP_EOK) lq.set(d, ctx.avgTv[i]);
    }
    liquidity.set(code, lq);
    if (ctx.goldens.length === 0) continue;
    for (const t of genTrades(ctx, { name: "v3", entryFilter: (c, e) => nearHighOk(c, e) })) {
      const tmp: DailyStockReturns = new Map();
      accumulateStockDailyReturns(tmp, new Map(), code, ctx.prices, [t], PERIOD_START, "KR", true);
      v3.push({ buyDate: t.buyDate, sellDate: t.sellDate, ret: t.returnPct, days: [...tmp.entries()].map(([d, es]) => ({ d, r: es[0].returnPct })) });
    }
  }
  stocks.sort(byCodeAsc);
  const byCode = new Map(stocks.map((s) => [s.code, s]));
  console.log(`종목 ${stocks.length}개, 거래일(2010~) ${CALF.length}일 ${CALF[0]}~${CALF[CALF.length - 1]}, 월말 ${monthEndSet.size}개`);

  // ---- 엔진 ----
  const endedBefore = new Date(Date.parse(cal[cal.length - 1]) - ENDED_GRACE_DAYS * MS_DAY).toISOString().slice(0, 10);
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
  const d4W = (d: string): Map<string, number> => { const el = eligibleAt(d); const t = el.reduce((a, x) => a + x.mcap, 0); return new Map(el.map((x) => [x.sk.code, x.mcap / t])); };
  const poolW = (d: string): Map<string, number> => {
    const el = eligibleAt(d).sort((a, b) => b.mcap - a.mcap || byCodeAsc(a.sk, b.sk)).slice(0, POOL_SIZE);
    const t = el.reduce((a, x) => a + x.mcap, 0);
    return new Map(el.map((x) => [x.sk.code, x.mcap / t]));
  };
  const prefixes = new Map<string, Float64Array>();
  for (const sk of stocks) { const pre = new Float64Array(sk.close.length + 1); for (let i = 0; i < sk.close.length; i++) pre[i + 1] = pre[i] + sk.close[i]; prefixes.set(sk.code, pre); }
  const passAt = (code: string, i: number, N: number): boolean => {
    if (i < N - 1) return false;
    const pre = prefixes.get(code)!;
    return byCode.get(code)!.close[i] > (pre[i + 1] - pre[i + 1 - N]) / N;
  };

  // D4 단독(simulateD4 재사용) → T1 신호용 지수
  const d4Sim = simulateD4(stocks, cal);
  if (d4Sim.dates.length !== CALF.length || d4Sim.dates[0] !== CALF[0]) throw new Error("D4 날짜 정렬 불일치");
  const level = new Float64Array(CALF.length);
  { let v = 1; for (let k = 0; k < CALF.length; k++) { v *= 1 + d4Sim.ret[k] / 100; level[k] = v; } }
  const lpre = new Float64Array(CALF.length + 1);
  for (let k = 0; k < CALF.length; k++) lpre[k + 1] = lpre[k] + level[k];
  const t1Flag = (k: number, N: number): boolean => k >= N - 1 && level[k] > (lpre[k + 1] - lpre[k + 1 - N]) / N;

  function run(kind: "D4" | "POOL" | CandKind, N: number, delay: boolean): Out {
    const startK = kind === "D4" || kind === "POOL" ? 0 : N - 1;
    let cash = 1, prevV = 1;
    const pos = new Map<string, { val: number; last: number }>();
    const out: Out = { dates: [], ret: [], costFrac: [], turn: [], sw: [] };
    let pending: Sig | null = null;
    let baseW = new Map<string, number>();
    let lastApplied = new Set<string>();
    let held = false;
    const carry = new Map<string, boolean>();
    let costF = 0;
    const totalV = (): number => cash + [...pos.values()].reduce((a, p) => a + p.val, 0);

    function applyFull(tg0: Map<string, number>, d: string, sellRate: number): void {
      const V = totalV();
      const tg = new Map<string, number>();
      for (const [code, w] of tg0) if (byCode.get(code)!.idx.has(d) && w > 0) tg.set(code, w);
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

    for (let k = startK; k < CALF.length; k++) {
      const d = CALF[k];
      const sellRate = 1 - computeEffectiveSellPrice(1, d, "KR");
      costF = 0;
      for (const [code, p] of [...pos.entries()]) {
        const sk = byCode.get(code)!;
        const i = sk.idx.get(d);
        if (i !== undefined) { p.val *= sk.close[i] / p.last; p.last = sk.close[i]; }
        else if (sk.dates[sk.dates.length - 1] < d && sk.dates[sk.dates.length - 1] < endedBefore) { costF += (p.val * sellRate) / prevV; cash += p.val * (1 - sellRate); pos.delete(code); }
      }
      const me = monthEndSet.has(d);
      if (kind === "D4" || kind === "POOL") {
        if (me) applyFull(kind === "D4" ? d4W(d) : poolW(d), d, sellRate);
      } else {
        const first = k === startK;
        let sig: Sig;
        if (kind === "T1") sig = { d, flag: t1Flag(k, N), full: me, P: new Set(), w: baseW };
        else {
          if (first || me) baseW = d4W(d);
          const P = new Set<string>();
          for (const code of baseW.keys()) {
            const sk = byCode.get(code)!;
            const i = sk.idx.get(d);
            if (i !== undefined) carry.set(code, passAt(code, i, N));
            if (carry.get(code)) P.add(code);
          }
          sig = { d, flag: false, full: first || me, P, w: baseW };
        }
        const exec = delay ? pending : sig;
        pending = sig;
        if (exec) {
          if (kind === "T1") {
            if (exec.flag && !held) { applyFull(d4W(exec.d), d, sellRate); held = true; out.sw.push({ d, n: 1 }); }
            else if (exec.flag && held && exec.full) applyFull(d4W(exec.d), d, sellRate);
            else if (!exec.flag && held) { applyFull(new Map(), d, sellRate); held = false; out.sw.push({ d, n: 1 }); }
          } else {
            const same = exec.P.size === lastApplied.size && [...exec.P].every((c) => lastApplied.has(c));
            if (kind === "T3") {
              if (exec.full || !same) {
                if (!exec.full) out.sw.push({ d, n: [...exec.P].filter((c) => !lastApplied.has(c)).length + [...lastApplied].filter((c) => !exec.P.has(c)).length });
                const live = [...exec.P].filter((c) => byCode.get(c)!.idx.has(d));
                const tw = live.reduce((a, c) => a + exec.w.get(c)!, 0);
                applyFull(tw > 0 ? new Map(live.map((c) => [c, exec.w.get(c)! / tw])) : new Map(), d, sellRate);
                lastApplied = new Set(exec.P);
              }
            } else if (exec.full) {
              applyFull(new Map([...exec.P].map((c) => [c, exec.w.get(c)!])), d, sellRate);
              lastApplied = new Set(exec.P);
            } else if (!same) {
              const exits = [...lastApplied].filter((c) => !exec.P.has(c)).sort();
              const entries = [...exec.P].filter((c) => !lastApplied.has(c)).sort();
              out.sw.push({ d, n: exits.length + entries.length });
              const V = totalV();
              let buyN = 0, sellN = 0, C = 0;
              for (const c of exits) { const p = pos.get(c); if (!p) continue; cash += p.val * (1 - sellRate); C += p.val * sellRate; sellN += p.val; pos.delete(c); }
              const next = new Set(exec.P);
              for (const c of entries) {
                const sk = byCode.get(c)!;
                const i = sk.idx.get(d);
                if (i === undefined) { next.delete(c); continue; }
                const amt = Math.min(exec.w.get(c)! * V, cash / (1 + buyRate));
                if (amt <= 0) { next.delete(c); continue; }
                pos.set(c, { val: amt, last: sk.close[i] });
                cash -= amt * (1 + buyRate); C += amt * buyRate; buyN += amt;
              }
              costF += V > 0 ? C / V : 0;
              if (buyN + sellN > 0) out.turn.push({ d, v: V > 0 ? (buyN + sellN) / 2 / V : 0 });
              lastApplied = next;
            }
          }
        }
      }
      const V = totalV();
      out.dates.push(d); out.ret.push((V / prevV - 1) * 100); out.costFrac.push(costF);
      prevV = V;
    }
    return out;
  }

  // ---- 지표 ----
  const endCap = (e: string): string => (e > TODAY ? TODAY : e);
  function st(dates: string[], rets: number[], win: Win, costFrac?: number[]) {
    const idx: number[] = [];
    for (let i = 0; i < dates.length; i++) if (dates[i] >= win.from && dates[i] <= win.to) idx.push(i);
    const r = idx.map((i) => rets[i]);
    const { totalReturnPct, mddPct } = computeCumulativeAndMdd(r);
    const cagr = computeCagrPct(totalReturnPct, win.from, endCap(win.to));
    const m = r.reduce((a, x) => a + x, 0) / Math.max(r.length, 1);
    const sd = Math.sqrt(r.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(r.length - 1, 1));
    return { cagr, mdd: mddPct, cm: mddPct > 0 ? cagr / mddPct : NaN, vol: sd * Math.sqrt(252), cost: costFrac ? idx.reduce((a, i) => a + costFrac[i], 0) * 100 : NaN };
  }
  const yearsOf = (win: Win): number => Math.max(dayDiff(win.from, endCap(win.to)) / 365.25, 1e-9);
  const inWin = (d: string, w: Win): boolean => d >= w.from && d <= w.to;
  const seriesYear = (dates: string[], rets: number[], y: number): number => computeCumulativeAndMdd(rets.filter((_, i) => dates[i].startsWith(`${y}-`))).totalReturnPct;

  // ---- 기준선 ----
  const d4Eng = run("D4", 0, false);
  let maxDiff = 0;
  for (let k = 0; k < CALF.length; k++) maxDiff = Math.max(maxDiff, Math.abs(d4Eng.ret[k] - d4Sim.ret[k]));
  console.log(`D4 일치 확인: simulateD4 대비 이 연구 엔진 D4의 최대 절대 일 수익률 차이 ${maxDiff.toExponential(2)}%p`);
  const poolEng = run("POOL", 0, false);
  const kp = kospi.filter((p) => p.tradeDate >= PERIOD_START);
  const kDates = kp.slice(1).map((p) => p.tradeDate);
  const kRets = computeIndexDailyReturnsPct(kp as never);
  const ew = simulateUniverseMonthlyRebalance(pricesByStock, CALF, PERIOD_START, (code, date) => (liquidity.get(code)?.get(date) ?? NaN) >= PIT_MIN_AVG_TRADING_VALUE_WON, true);
  const v3Sum = new Map<string, number>(), v3Cnt = new Map<string, number>();
  for (const t of v3) for (const { d, r } of t.days) { v3Sum.set(d, (v3Sum.get(d) ?? 0) + r); v3Cnt.set(d, (v3Cnt.get(d) ?? 0) + 1); }
  const v3Ret = CALF.map((d) => { const c = v3Cnt.get(d) ?? 0; return c === 0 ? 0 : ((v3Sum.get(d) ?? 0) / c) * 100; });
  const v3Full = st(CALF, v3Ret, { from: PERIOD_START, to: "9999-12-31" });
  const nV3 = v3.filter((t) => t.buyDate >= PERIOD_START).length;
  console.log(`v3 재현(비교용, 중단 아님): CAGR ${f2(v3Full.cagr)} / MDD ${f2(v3Full.mdd)} / 거래 ${nV3}건 (기준 ${EXPECT_V3.cagr} / ${EXPECT_V3.mdd} / ${EXPECT_V3.trades}) → ${f2(v3Full.cagr) === EXPECT_V3.cagr && f2(v3Full.mdd) === EXPECT_V3.mdd && nV3 === EXPECT_V3.trades ? "일치" : "불일치"}`);

  // ---- 후보 실행 ----
  interface Cand { kind: CandKind; N: number; name: string; base: Out; dly: Out }
  const cands: Cand[] = [];
  for (const N of NS) for (const kind of KINDS) cands.push({ kind, N, name: `${kind}(${N})`, base: run(kind, N, false), dly: run(kind, N, true) });
  console.log(`후보 ${cands.length}개 × (기본, 지연) 실행 완료, 경과 ${((Date.now() - T0) / 60000).toFixed(1)}분`);

  const startOf = (N: number): string => CALF[N - 1];
  const winsOf = (from: string): [string, Win][] => [["학습", { from, to: LEARN_END }], ["확인", { from: CONFIRM_START, to: "9999-12-31" }], ["전체", { from, to: "9999-12-31" }]];
  const srcs = {
    D4: { dates: CALF, ret: d4Sim.ret, cost: d4Eng.costFrac }, POOL: { dates: CALF, ret: poolEng.ret, cost: poolEng.costFrac },
    KOSPI: { dates: kDates, ret: kRets, cost: undefined as number[] | undefined }, "유니버스 동일가중": { dates: CALF, ret: ew, cost: undefined as number[] | undefined }, v3: { dates: CALF, ret: v3Ret, cost: undefined as number[] | undefined },
  };
  type St = ReturnType<typeof st>;
  const S = new Map<string, St>();
  const key = (who: string, N: number, w: string): string => `${who}|${N}|${w}`;
  for (const N of NS) {
    for (const [wn, win] of winsOf(startOf(N))) {
      for (const [lab, s] of Object.entries(srcs)) S.set(key(lab, N, wn), st(s.dates, s.ret, win, s.cost));
      for (const c of cands.filter((x) => x.N === N)) {
        S.set(key(c.name, N, wn), st(c.base.dates, c.base.ret, win, c.base.costFrac));
        S.set(key(c.name + "+지연", N, wn), st(c.dly.dates, c.dly.ret, win, c.dly.costFrac));
      }
    }
  }

  console.log("\n=== (b) 후보 × 기간 표 (CAGR % / MDD % / CAGR÷MDD / 연변동성 % / 거래비용 누적 %) ===");
  for (const N of NS) {
    console.log(`\n[N=${N}] 첫 정의일 S_N = ${startOf(N)} (학습 ${startOf(N)}~${LEARN_END}, 확인 ${CONFIRM_START}~데이터 끝, 전체 ${startOf(N)}~데이터 끝)`);
    for (const [wn] of winsOf(startOf(N))) {
      console.log(`\n(${wn})`);
      console.log("| 구성 | CAGR % | MDD % | CAGR÷MDD | 연변동성 % | 거래비용 누적 % |\n|---|---|---|---|---|---|");
      const rows = [...KINDS.map((k) => `${k}(${N})`), "D4", "POOL", "KOSPI", "유니버스 동일가중", "v3"];
      for (const lab of rows) { const x = S.get(key(lab, N, wn))!; console.log(`| ${lab} | ${f2(x.cagr)} | ${f2(x.mdd)} | ${f2(x.cm)} | ${f2(x.vol)} | ${f2(x.cost)} |`); }
    }
  }

  console.log("\n=== (c) 학습·확인 기준 ===");
  console.log("| 후보 | 구간 | CAGR | D4 CAGR | 기준1(CAGR ≥ D4−2.0) | MDD | 0.80×D4 MDD | 기준2 | CAGR÷MDD | D4 CAGR÷MDD | 기준3 | 비고 |\n|---|---|---|---|---|---|---|---|---|---|---|---|");
  const verdict = new Map<string, string>();
  for (const c of cands) {
    const crit = (wn: string): { a: boolean; b: boolean; cc: boolean } => {
      const x = S.get(key(c.name, c.N, wn))!, d = S.get(key("D4", c.N, wn))!;
      const a = x.cagr >= d.cagr - TR_CAGR_MARGIN, b = x.mdd <= TR_MDD_RATIO * d.mdd, cc = x.cm > d.cm;
      const pre = wn === "학습" ? "TR" : "CF";
      console.log(`| ${c.name} | ${wn} | ${f2(x.cagr)} | ${f2(d.cagr)} | ${pre}1 ${ox(a)} | ${f2(x.mdd)} | ${f2(TR_MDD_RATIO * d.mdd)} | ${pre}2 ${ox(b)} | ${f2(x.cm)} | ${f2(d.cm)} | ${pre}3 ${ox(cc)} | |`);
      return { a, b, cc };
    };
    const L = crit("학습"), C = crit("확인");
    const dropC = S.get(key(c.name, c.N, "확인"))!.cagr - S.get(key(c.name + "+지연", c.N, "확인"))!.cagr;
    const cf4 = dropC <= CF4_MAX_DROP;
    console.log(`| ${c.name} | 확인 | 지연 CAGR ${f2(S.get(key(c.name + "+지연", c.N, "확인"))!.cagr)} | 기본 CAGR ${f2(S.get(key(c.name, c.N, "확인"))!.cagr)} | CF4(하락 ${f2(dropC)}%p ≤ ${CF4_MAX_DROP}) ${ox(cf4)} | | | | | | | |`);
    const learnPass = L.a && L.b && L.cc;
    verdict.set(c.name, learnPass ? (C.a && C.b && C.cc && cf4 ? "확인 진행 O / 확인 통과 O" : "확인 진행 O / 확인 통과 X") : "확인 진행 X / 표시 없음(-)");
  }
  console.log("\n| 후보 | 표시 |\n|---|---|");
  for (const c of cands) console.log(`| ${c.name} | ${verdict.get(c.name)} |`);

  console.log("\n=== (d) 연도별 수익률 % (후보는 S_N 이후만 포함, D4·KOSPI는 해당 연도 전체) ===");
  const years: number[] = [];
  for (let y = 2010; y <= CURRENT_YEAR; y++) years.push(y);
  console.log("| 구성 | " + years.join(" | ") + " |\n|---|" + years.map(() => "---").join("|") + "|");
  for (const c of cands) console.log(`| ${c.name} | ${years.map((y) => f2(seriesYear(c.base.dates, c.base.ret, y))).join(" | ")} |`);
  console.log(`| D4 | ${years.map((y) => f2(seriesYear(CALF, d4Sim.ret, y))).join(" | ")} |`);
  console.log(`| KOSPI | ${years.map((y) => f2(seriesYear(kDates, kRets, y))).join(" | ")} |`);

  console.log("\n=== (e) 신호 +1거래일 지연 결과 (기본 vs 지연) ===");
  console.log("| 후보 | 구간 | 기본 CAGR | 지연 CAGR | 하락 %p | 기본 MDD | 지연 MDD | 지연 CAGR÷MDD | 지연 연변동성 | 지연 비용 누적 % |\n|---|---|---|---|---|---|---|---|---|---|");
  for (const c of cands) for (const wn of ["학습", "확인", "전체"]) {
    const b = S.get(key(c.name, c.N, wn))!, x = S.get(key(c.name + "+지연", c.N, wn))!;
    console.log(`| ${c.name} | ${wn} | ${f2(b.cagr)} | ${f2(x.cagr)} | ${f2(b.cagr - x.cagr)} | ${f2(b.mdd)} | ${f2(x.mdd)} | ${f2(x.cm)} | ${f2(x.vol)} | ${f2(x.cost)} |`);
  }

  console.log("\n=== (f) 정보용 지표 ===");
  console.log(`\n(f-1) N=224 vs N=200 차이 (공통 구간: S_224=${startOf(224)} 이후 같은 날짜 범위에서 재계산)`);
  console.log("| 구조 | 구간 | N=224 CAGR | N=200 CAGR | |ΔCAGR| %p | N=224 MDD | N=200 MDD | |ΔMDD| %p |\n|---|---|---|---|---|---|---|---|");
  for (const kind of KINDS) for (const [wn, win] of winsOf(startOf(224))) {
    const a = cands.find((c) => c.kind === kind && c.N === 224)!, b = cands.find((c) => c.kind === kind && c.N === 200)!;
    const xa = st(a.base.dates, a.base.ret, win), xb = st(b.base.dates, b.base.ret, win);
    console.log(`| ${kind} | ${wn} | ${f2(xa.cagr)} | ${f2(xb.cagr)} | ${f2(Math.abs(xa.cagr - xb.cagr))} | ${f2(xa.mdd)} | ${f2(xb.mdd)} | ${f2(Math.abs(xa.mdd - xb.mdd))} |`);
  }
  console.log("\n(f-2) 연간 전환 횟수·연간 회전율·비용 누적·POOL 대비 (기본 변형)");
  console.log("| 후보 | 구간 | 연간 전환 횟수 | 연간 회전율 % | 비용 누적 % | CAGR − POOL %p | MDD − POOL %p |\n|---|---|---|---|---|---|---|");
  for (const c of cands) for (const [wn, win] of winsOf(startOf(c.N))) {
    const yrs = yearsOf(win);
    const sw = c.base.sw.filter((x) => inWin(x.d, win)).reduce((a, x) => a + x.n, 0) / yrs;
    const tu = (c.base.turn.filter((x) => inWin(x.d, win)).reduce((a, x) => a + x.v, 0) / yrs) * 100;
    const x = S.get(key(c.name, c.N, wn))!, p = S.get(key("POOL", c.N, wn))!;
    console.log(`| ${c.name} | ${wn} | ${f2(sw)} | ${f2(tu)} | ${f2(x.cost)} | ${f2(x.cagr - p.cagr)} | ${f2(x.mdd - p.mdd)} |`);
  }

  console.log("\n=== (g) 실행 지표 ===");
  console.log(`Supabase 읽은 행: ${Object.entries(dbRead).map(([k, v]) => `${k} ${v}`).join(" | ")} | 합계 ${Object.values(dbRead).reduce((a, b) => a + b, 0)}`);
  console.log(`Supabase 쓴 행: 0 | 외부 요청(DART/KIS 등): 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
