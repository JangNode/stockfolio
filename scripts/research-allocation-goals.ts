/**
 * [임시 연구 — 병합 금지, 읽기 전용, 외부 요청 0건] 목표별 3계열(R·D·E) 자산 배분 6변형 → 계열별 학습 선택 → 확인 → (통과 시) 홀드아웃.
 * 정의는 research/allocation-goals-prereg.md(사전 등록 8c1b38fe 이후). DB 쓰기 없음.
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getIndexPriceSeries } from "@/lib/betaPriceHistoryStorage";
import { loadAllStockSeriesFromParquet } from "@/lib/stockDailyPricesStorage";
import { loadAppliedAdjustments } from "@/lib/stockPriceAdjustmentsStorage";
import { STOCK_DATA_EARLIEST_YEAR, STRATEGY_BACKTEST_PRICE_FETCH_LOOKBACK_YEARS } from "@/lib/strategyBacktestSummaryConfig";
import { computeCumulativeAndMdd, computeCagrPct } from "@/lib/strategyBacktestSummary";
import { computeIndexDailyReturnsPct } from "@/lib/benchmarkSummary";
import { buildCtx, PERIOD_START } from "./research-ma-lab";
import { simulateD4, type Sk } from "./research-audit-peg";
import {
  ETF_SPIKE_MIN_ABS_RET, ETF_SPIKE_MAX_NET_ABS, ETF_SPIKE_KOSPI_EXEMPT_RATIO, ETF_FEE_RATE, ETF_SLIPPAGE_RATE, ETF_RUN_FIRST_DECISION_MONTH,
  ETF_A2_SMA_MONTHS, ETF_A4_VOL_DAYS, ETF_LEARN, ETF_CONFIRM, ETF_HOLDOUT_FROM, ETF_TRADING_DAYS_PER_YEAR,
} from "@/lib/etfAllocationConfig";
import {
  ALLOC_GOALS_ASSETS, R_MDD_MARGIN_PP, D_MDD_RATIO, D_CAGR_RATIO, GOALS_MAX_DELAY_DROP_PP, R2_WEIGHTS, D1_WEIGHTS, E2_WEIGHTS, D2_DEFENSE_WEIGHTS,
} from "@/lib/allocationGoalsConfig";

const T0 = Date.now();
const dbRead: Record<string, number> = {};
const f2 = (x: number): string => (Number.isFinite(x) ? x.toFixed(2) : "-");
const ox = (b: boolean): string => (b ? "O" : "X");
const MS_DAY = 86_400_000;
const CURRENT_YEAR = new Date().getUTCFullYear();
const FETCH_START = Math.max(STOCK_DATA_EARLIEST_YEAR, Number(PERIOD_START.slice(0, 4)) - STRATEGY_BACKTEST_PRICE_FETCH_LOOKBACK_YEARS);
const COST_RATE = ETF_FEE_RATE + ETF_SLIPPAGE_RATE;
const NA = ALLOC_GOALS_ASSETS.length;
const [I_STK, I_B3, I_B10, I_GLD, I_LEV] = [0, 1, 2, 3, 4];

interface Win { from: string; to: string }
interface Run { dates: string[]; ret: number[]; costFrac: number[]; turn: number[] }
interface Decision { k: number; date: string; w: number[] }
type VarId = "R1" | "R2" | "D1" | "D2" | "E1" | "E2";
type Fam = "R" | "D" | "E";
const FAMILIES: { fam: Fam; vars: VarId[] }[] = [{ fam: "R", vars: ["R1", "R2"] }, { fam: "D", vars: ["D1", "D2"] }, { fam: "E", vars: ["E1", "E2"] }];
type Stats = { cagr: number; mdd: number; cm: number; vol: number; sharpe: number; cost: number; turn: number };

async function readEtf(): Promise<Map<string, { date: string; px: number }[]>> {
  const out = new Map<string, { date: string; px: number }[]>();
  for (const code of ALLOC_GOALS_ASSETS) {
    const rows: { date: string; px: number }[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabaseAdmin.from("etf_daily_prices").select("trade_date, adj_close").eq("code", code).order("trade_date").range(from, from + 999);
      if (error) throw new Error(`etf_daily_prices 읽기 실패 ${code}: ${error.message}`);
      for (const r of data ?? []) rows.push({ date: r.trade_date as string, px: Number(r.adj_close) });
      dbRead[`etf_daily_prices(${code})`] = (dbRead[`etf_daily_prices(${code})`] ?? 0) + (data?.length ?? 0);
      if (!data || data.length < 1000) break;
    }
    out.set(code, rows);
  }
  return out;
}

async function main(): Promise<void> {
  console.log(`목표별 3계열 자산 배분 시작(읽기 전용): ${new Date().toISOString()} (사전등록 8c1b38fe 이후)`);
  const raw = await readEtf();
  const kospi = await getIndexPriceSeries("KOSPI", "2008-01-01", "2099-12-31");
  dbRead["beta_price_history(KOSPI)"] = kospi.length;
  const kRetByDate = new Map<string, number>();
  for (let i = 1; i < kospi.length; i++) kRetByDate.set(kospi[i].tradeDate, kospi[i].closePrice / kospi[i - 1].closePrice - 1);
  const stkRaw = raw.get(ALLOC_GOALS_ASSETS[I_STK])!;
  const stkRetByDate = new Map<string, number>();
  for (let i = 1; i < stkRaw.length; i++) stkRetByDate.set(stkRaw[i].date, stkRaw[i].px / stkRaw[i - 1].px - 1);

  // ---- (b) 정제 ----
  console.log("\n=== (b) 정제: 바꾼 날짜 ===\n| 종목 | 날짜 | 원래 가격 | 바꾼 가격 |\n|---|---|---|---|");
  const clean = new Map<string, { date: string; px: number }[]>();
  for (const code of ALLOC_GOALS_ASSETS) {
    const s = raw.get(code)!;
    const r = s.map((x, i) => (i === 0 ? NaN : x.px / s[i - 1].px - 1));
    const out = s.map((x) => ({ ...x }));
    for (let t = 1; t + 1 < s.length; t++) {
      if (!(Math.abs(r[t]) > ETF_SPIKE_MIN_ABS_RET)) continue;
      if (!(Math.sign(r[t + 1]) === -Math.sign(r[t]))) continue;
      if (!(Math.abs((1 + r[t]) * (1 + r[t + 1]) - 1) < ETF_SPIKE_MAX_NET_ABS)) continue;
      const ref = code === ALLOC_GOALS_ASSETS[I_STK] ? kRetByDate.get(s[t].date) : code === ALLOC_GOALS_ASSETS[I_LEV] ? stkRetByDate.get(s[t].date) : undefined;
      if (ref !== undefined && Math.sign(ref) === Math.sign(r[t]) && Math.abs(ref) >= ETF_SPIKE_KOSPI_EXEMPT_RATIO * Math.abs(r[t])) continue;
      out[t].px = Math.sqrt(s[t - 1].px * s[t + 1].px);
      console.log(`| ${code} | ${s[t].date} | ${s[t].px} | ${out[t].px.toFixed(2)} |`);
    }
    clean.set(code, out);
  }

  // ---- 달력·월말 ----
  const sets = ALLOC_GOALS_ASSETS.map((c) => new Set(clean.get(c)!.map((x) => x.date)));
  const cal = [...sets[0]].filter((d) => sets.every((st) => st.has(d))).sort();
  const P: Float64Array[] = ALLOC_GOALS_ASSETS.map((c) => {
    const m = new Map(clean.get(c)!.map((x) => [x.date, x.px]));
    return Float64Array.from(cal.map((d) => m.get(d)!));
  });
  const meK: number[] = [];
  for (let k = 0; k + 1 < cal.length; k++) if (cal[k].slice(0, 7) !== cal[k + 1].slice(0, 7)) meK.push(k);
  console.log(`\n달력(5자산 교집합) ${cal.length}일 ${cal[0]}~${cal[cal.length - 1]}, 월말 ${meK.length}개`);
  const firstDecM = meK.findIndex((k) => cal[k].slice(0, 7) === ETF_RUN_FIRST_DECISION_MONTH);
  if (firstDecM < 0) throw new Error("첫 결정일 월말 없음");
  const startK = meK[firstDecM];
  const dayRet = (a: number, k: number): number => P[a][k] / P[a][k - 1] - 1;

  const one = (a: number): number[] => ALLOC_GOALS_ASSETS.map((_, i) => (i === a ? 1 : 0));
  function trendOn(m: number): boolean {
    let sum = 0;
    for (let j = m - (ETF_A2_SMA_MONTHS - 1); j <= m; j++) sum += P[I_STK][meK[j]];
    return P[I_STK][meK[m]] > sum / ETF_A2_SMA_MONTHS;
  }
  function target(v: VarId, m: number): number[] {
    const k = meK[m];
    if (v === "R1") return trendOn(m) ? one(I_LEV) : one(I_B3);
    if (v === "R2") return [...R2_WEIGHTS];
    if (v === "D1") return [...D1_WEIGHTS];
    if (v === "D2") return trendOn(m) ? one(I_STK) : [...D2_DEFENSE_WEIGHTS];
    if (v === "E2") return [...E2_WEIGHTS];
    const inv = new Array<number>(NA).fill(0);
    for (const a of [I_STK, I_B3, I_GLD]) {
      let s = 0, s2 = 0;
      for (let j = k - ETF_A4_VOL_DAYS + 1; j <= k; j++) { const r = dayRet(a, j); s += r; s2 += r * r; }
      const mean = s / ETF_A4_VOL_DAYS;
      inv[a] = 1 / Math.sqrt((s2 - ETF_A4_VOL_DAYS * mean * mean) / (ETF_A4_VOL_DAYS - 1));
    }
    const tot = inv.reduce((x, y) => x + y, 0);
    return inv.map((x) => x / tot);
  }

  function simulate(v: VarId, delay: boolean): { run: Run; decisions: Decision[] } {
    const dates: string[] = [], ret: number[] = [], costFrac: number[] = [], turn: number[] = [];
    const decisions: Decision[] = [];
    const pos = new Array<number>(NA).fill(0);
    let cash = 1, prevV = 1;
    let pending: number[] | null = null;
    const decAt = new Map<number, number>();
    for (let m = firstDecM; m < meK.length; m++) decAt.set(meK[m], m);
    for (let k = startK; k < cal.length; k++) {
      if (k > startK) for (let a = 0; a < NA; a++) pos[a] *= P[a][k] / P[a][k - 1];
      let cf = 0, tu = 0;
      const execute = (w: number[]): void => {
        const V = cash + pos.reduce((x, y) => x + y, 0);
        let buyN = 0, sellN = 0;
        for (let a = 0; a < NA; a++) { const diff = w[a] * V - pos[a]; if (diff > 0) buyN += diff; else sellN += -diff; }
        const C = (buyN + sellN) * COST_RATE;
        const scale = (V - C) / V;
        for (let a = 0; a < NA; a++) pos[a] = w[a] * V * scale;
        cash = V - C - pos.reduce((x, y) => x + y, 0);
        cf += C / V;
        tu += (buyN + sellN) / 2 / V;
      };
      if (delay && pending) { execute(pending); pending = null; }
      const m = decAt.get(k);
      if (m !== undefined) {
        const w = target(v, m);
        decisions.push({ k, date: cal[k], w });
        if (delay) pending = w; else execute(w);
      }
      const V = cash + pos.reduce((x, y) => x + y, 0);
      dates.push(cal[k]); ret.push((V / prevV - 1) * 100); costFrac.push(cf); turn.push(tu);
      prevV = V;
    }
    return { run: { dates, ret, costFrac, turn }, decisions };
  }

  // ---- 지표 ----
  const lastDate = cal[cal.length - 1];
  const yearsOf = (w: Win): number => Math.max((Date.parse(w.to) - Date.parse(w.from)) / MS_DAY / 365.25, 1e-9);
  function st(dates: string[], rets: number[], win: Win, costFrac?: number[], turn?: number[]): Stats {
    const idx: number[] = [];
    for (let i = 0; i < dates.length; i++) if (dates[i] >= win.from && dates[i] <= win.to) idx.push(i);
    const r = idx.map((i) => rets[i]);
    const { totalReturnPct, mddPct } = computeCumulativeAndMdd(r);
    const cagr = computeCagrPct(totalReturnPct, win.from, win.to);
    const m = r.reduce((a, x) => a + x, 0) / Math.max(r.length, 1);
    const sd = Math.sqrt(r.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(r.length - 1, 1));
    return {
      cagr, mdd: mddPct, cm: mddPct > 0 ? cagr / mddPct : NaN, vol: sd * Math.sqrt(ETF_TRADING_DAYS_PER_YEAR),
      sharpe: sd > 0 ? (m * ETF_TRADING_DAYS_PER_YEAR) / (sd * Math.sqrt(ETF_TRADING_DAYS_PER_YEAR)) : NaN,
      cost: costFrac ? idx.reduce((a, i) => a + costFrac[i], 0) * 100 : NaN,
      turn: turn ? idx.reduce((a, i) => a + turn[i], 0) / yearsOf(win) : NaN,
    };
  }
  const yearRet = (dates: string[], rets: number[], y: number, win: Win): number =>
    computeCumulativeAndMdd(rets.filter((_, i) => dates[i].startsWith(`${y}-`) && dates[i] >= win.from && dates[i] <= win.to)).totalReturnPct;

  const bhRun: Run = { dates: cal.slice(startK), ret: cal.slice(startK).map((_, i) => (i === 0 ? 0 : dayRet(I_STK, startK + i) * 100)), costFrac: cal.slice(startK).map(() => 0), turn: cal.slice(startK).map(() => 0) };
  const kp = kospi.filter((p) => p.tradeDate >= "2012-12-01");
  const kDates = kp.slice(1).map((p) => p.tradeDate);
  const kRets = computeIndexDailyReturnsPct(kp as never);

  console.log("\nD4 계산 시작(Parquet 캐시)");
  const adjustments = await loadAppliedAdjustments();
  dbRead["stock_price_adjustment_events(applied)"] = [...adjustments.values()].reduce((a, l) => a + l.length, 0);
  const series = await loadAllStockSeriesFromParquet(FETCH_START, CURRENT_YEAR, adjustments);
  const calSet = new Set<string>();
  for (const rows of series.values()) for (const r of rows) calSet.add(r.tradeDate);
  const stockCal = [...calSet].sort();
  const stocks: Sk[] = [];
  for (const [code, rows] of series) {
    const ctx = buildCtx(code, rows);
    series.delete(code);
    stocks.push({ code, dates: ctx.prices.map((p) => p.date), close: Float64Array.from(ctx.closes), mcap: Float64Array.from(rows.map((r) => r.marketCapEok)), avgTv: ctx.avgTv, idx: new Map(ctx.prices.map((p, i) => [p.date, i])) });
  }
  stocks.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  const d4 = simulateD4(stocks, stockCal);

  // ---- 계열 기준 ----
  type GateRow = { names: string[]; ok: boolean[] };
  function gatesFor(fam: Fam, x: Stats, bh: Stats, drop: number): GateRow {
    if (fam === "R") return { names: ["RG1", "RG2", "RG3"], ok: [x.cagr > bh.cagr, x.mdd <= bh.mdd + R_MDD_MARGIN_PP, drop <= GOALS_MAX_DELAY_DROP_PP] };
    if (fam === "D") return { names: ["DG1", "DG2", "DG3"], ok: [x.mdd <= D_MDD_RATIO * bh.mdd, bh.cagr > 0 ? x.cagr >= D_CAGR_RATIO * bh.cagr : x.cagr >= bh.cagr, drop <= GOALS_MAX_DELAY_DROP_PP] };
    return { names: ["EG1", "EG2", "EG3"], ok: [x.sharpe > bh.sharpe, x.cm > bh.cm, drop <= GOALS_MAX_DELAY_DROP_PP] };
  }
  const HEAD = "| 구분 | CAGR | MDD | 샤프 | CAGR÷MDD | 연변동성 | 연 회전율 | 누적 비용 % | 지연 CAGR | 하락 %p | ";
  const refLine = (name: string, s: Stats, turn?: string, cost?: string): string =>
    `| ${name} | ${f2(s.cagr)} | ${f2(s.mdd)} | ${f2(s.sharpe)} | ${f2(s.cm)} | ${f2(s.vol)} | ${turn ?? "-"} | ${cost ?? "-"} | | | | | |`;

  const sims = new Map<VarId, { base: ReturnType<typeof simulate>; delayed: ReturnType<typeof simulate> }>();
  for (const { vars } of FAMILIES) for (const v of vars) sims.set(v, { base: simulate(v, false), delayed: simulate(v, true) });

  for (const { fam, vars } of FAMILIES) {
    console.log(`\n################ ${fam} 계열 ################`);
    const learn: Win = { ...ETF_LEARN };
    const bhL = st(bhRun.dates, bhRun.ret, learn, bhRun.costFrac, bhRun.turn);
    const rows = vars.map((v) => {
      const { base, delayed } = sims.get(v)!;
      const s = st(base.run.dates, base.run.ret, learn, base.run.costFrac, base.run.turn);
      const sd = st(delayed.run.dates, delayed.run.ret, learn, delayed.run.costFrac, delayed.run.turn);
      const drop = s.cagr - sd.cagr;
      return { v, s, sd, drop, g: gatesFor(fam, s, bhL, drop) };
    });
    const names = rows[0].g.names;
    console.log(`=== (c) ${fam} 학습 2013-01-01~2018-12-31 ===`);
    console.log(HEAD + names.join(" | ") + " |\n|" + "---|".repeat(10 + names.length));
    for (const r of rows) console.log(`| ${r.v} | ${f2(r.s.cagr)} | ${f2(r.s.mdd)} | ${f2(r.s.sharpe)} | ${f2(r.s.cm)} | ${f2(r.s.vol)} | ${f2(r.s.turn)} | ${f2(r.s.cost)} | ${f2(r.sd.cagr)} | ${f2(r.drop)} | ${r.g.ok.map(ox).join(" | ")} |`);
    console.log(refLine("B&H(069500)", bhL, f2(bhL.turn), f2(bhL.cost)));
    console.log(refLine("KOSPI", st(kDates, kRets, learn)));
    console.log(refLine("D4", st(d4.dates, d4.ret, learn)));

    const passers = rows.filter((r) => r.g.ok.every(Boolean));
    console.log(`\n=== (d) ${fam} 선택 ===`);
    if (passers.length === 0) { console.log("선택 없음"); continue; }
    const key = (r: (typeof rows)[number]): number => (fam === "R" ? r.s.cagr : fam === "D" ? -r.s.mdd : r.s.sharpe);
    passers.sort((a, b) => key(b) - key(a) || a.s.turn - b.s.turn);
    const sel = passers[0].v;
    console.log(`전부 O 변형: ${passers.map((p) => p.v).join(", ")} → 선택 ${sel}`);
    const { base, delayed } = sims.get(sel)!;

    const stage = (label: string, win: Win): boolean => {
      const bh = st(bhRun.dates, bhRun.ret, win, bhRun.costFrac, bhRun.turn);
      const s = st(base.run.dates, base.run.ret, win, base.run.costFrac, base.run.turn);
      const sd = st(delayed.run.dates, delayed.run.ret, win, delayed.run.costFrac, delayed.run.turn);
      const drop = s.cagr - sd.cagr;
      const g = gatesFor(fam, s, bh, drop);
      console.log(`\n=== ${label} ${fam} ${win.from}~${win.to} ===`);
      console.log(HEAD + g.names.join(" | ") + " |\n|" + "---|".repeat(10 + g.names.length));
      console.log(`| ${sel} | ${f2(s.cagr)} | ${f2(s.mdd)} | ${f2(s.sharpe)} | ${f2(s.cm)} | ${f2(s.vol)} | ${f2(s.turn)} | ${f2(s.cost)} | ${f2(sd.cagr)} | ${f2(drop)} | ${g.ok.map(ox).join(" | ")} |`);
      console.log(refLine("B&H(069500)", bh, f2(bh.turn), f2(bh.cost)));
      console.log(refLine("KOSPI", st(kDates, kRets, win)));
      console.log(refLine("D4", st(d4.dates, d4.ret, win)));
      console.log(`연도별 수익률 %\n| 연도 | ${sel} | B&H |\n|---|---|---|`);
      for (let y = Number(win.from.slice(0, 4)); y <= Number(win.to.slice(0, 4)); y++) console.log(`| ${y} | ${f2(yearRet(base.run.dates, base.run.ret, y, win))} | ${f2(yearRet(bhRun.dates, bhRun.ret, y, win))} |`);
      return g.ok.every(Boolean);
    };
    if (!stage("(e) 확인", { ...ETF_CONFIRM })) { console.log(`\n${fam} 확인 결과: 통과 아님 (홀드아웃 계산하지 않음)`); continue; }
    const holdOk = stage("(f) 홀드아웃", { from: ETF_HOLDOUT_FROM, to: lastDate });
    console.log(`\n${fam} 최종: ${holdOk ? "통과" : "통과 아님"}`);
  }
  console.log(`\n(g) KIS 요청 0(이 단계), Supabase 읽은 행 ${JSON.stringify(dbRead)} 쓴 행 0 소요 ${((Date.now() - T0) / 1000).toFixed(1)}s`);
}

main().catch((e) => { console.error("실패:", e instanceof Error ? e.message : e); process.exit(1); });
