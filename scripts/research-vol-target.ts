/**
 * [임시 연구 — 병합 금지, 읽기 전용, 외부 요청 0건] 변동성 목표화 V1(N=20)·V2(N=60) 학습 선택 → 확인 → (통과 시) 홀드아웃.
 * 정의는 research/vol-target-prereg.md(사전 등록 a7b24da5 이후). DB 쓰기 없음.
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getIndexPriceSeries } from "@/lib/betaPriceHistoryStorage";
import { computeCumulativeAndMdd, computeCagrPct } from "@/lib/strategyBacktestSummary";
import { computeIndexDailyReturnsPct } from "@/lib/benchmarkSummary";
import { ETF_SPIKE_MIN_ABS_RET, ETF_SPIKE_MAX_NET_ABS, ETF_SPIKE_KOSPI_EXEMPT_RATIO, ETF_FEE_RATE, ETF_SLIPPAGE_RATE, ETF_TRADING_DAYS_PER_YEAR } from "@/lib/etfAllocationConfig";
import { SEASON_STOCK_CODE, SEASON_BOND_CODE, SEASON_RUN_START_YEAR, SEASON_LEARN, SEASON_CONFIRM, SEASON_HOLDOUT_FROM } from "@/lib/seasonalityConfig";
import { VOL_TARGET_ANNUAL, VOL_TARGET_REBALANCE_BAND, VOL_TARGET_VARIANTS, VOL_TARGET_G1_CAGR_MARGIN_PP, VOL_TARGET_G4_MAX_DELAY_DROP_PP } from "@/lib/volTargetConfig";

const T0 = Date.now();
const COST = ETF_FEE_RATE + ETF_SLIPPAGE_RATE;
const MS_DAY = 86_400_000;
const f2 = (x: number): string => (Number.isFinite(x) ? x.toFixed(2) : "-");
const ox = (b: boolean): string => (b ? "O" : "X");
const dbRead: Record<string, number> = {};
type VarId = (typeof VOL_TARGET_VARIANTS)[number]["id"];
interface Win { from: string; to: string }
interface Run { dates: string[]; ret: number[]; costFrac: number[]; reb: number[]; wStock: number[] }
interface Stats { cagr: number; mdd: number; sharpe: number; cm: number; vol: number; avgW: number; reb: number; cost: number }

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
  console.log(`변동성 목표화 시작(읽기 전용): ${new Date().toISOString()} (사전등록 a7b24da5 이후)`);
  const kospi = await getIndexPriceSeries("KOSPI", "2008-01-01", "2099-12-31");
  dbRead["beta_price_history(KOSPI)"] = kospi.length;
  const kRetByDate = new Map<string, number>();
  for (let i = 1; i < kospi.length; i++) kRetByDate.set(kospi[i].tradeDate, kospi[i].closePrice / kospi[i - 1].closePrice - 1);

  // ---- 정제 ----
  const codes = [SEASON_STOCK_CODE, SEASON_BOND_CODE];
  const clean = new Map<string, { date: string; px: number }[]>();
  console.log("\n정제로 바꾼 날짜 (종목, 날짜, 원래 가격, 바꾼 가격):");
  let nChanged = 0;
  for (const code of codes) {
    const s = await readEtf(code);
    const r = s.map((x, i) => (i === 0 ? NaN : x.px / s[i - 1].px - 1));
    const out = s.map((x) => ({ ...x }));
    for (let t = 1; t + 1 < s.length; t++) {
      if (!(Math.abs(r[t]) > ETF_SPIKE_MIN_ABS_RET)) continue;
      if (!(Math.sign(r[t + 1]) === -Math.sign(r[t]))) continue;
      if (!(Math.abs((1 + r[t]) * (1 + r[t + 1]) - 1) < ETF_SPIKE_MAX_NET_ABS)) continue;
      if (code === SEASON_STOCK_CODE) {
        const kr = kRetByDate.get(s[t].date);
        if (kr !== undefined && Math.sign(kr) === Math.sign(r[t]) && Math.abs(kr) >= ETF_SPIKE_KOSPI_EXEMPT_RATIO * Math.abs(r[t])) continue;
      }
      out[t].px = Math.sqrt(s[t - 1].px * s[t + 1].px);
      nChanged++;
      console.log(`  ${code} ${s[t].date} ${s[t].px} → ${out[t].px.toFixed(2)}`);
    }
    clean.set(code, out);
  }
  if (!nChanged) console.log("  없음");

  // ---- 달력 ----
  const sets = codes.map((c) => new Set(clean.get(c)!.map((x) => x.date)));
  const cal = [...sets[0]].filter((d) => sets[1].has(d)).sort();
  const P = codes.map((c) => { const m = new Map(clean.get(c)!.map((x) => [x.date, x.px])); return Float64Array.from(cal.map((d) => m.get(d)!)); });
  const N = cal.length, lastDate = cal[N - 1];
  const isME = (k: number): boolean => k + 1 < N && cal[k].slice(0, 7) !== cal[k + 1].slice(0, 7);
  let s0 = -1;
  for (let k = 0; k + 1 < N; k++) if (isME(k) && cal[k].startsWith(`${SEASON_RUN_START_YEAR}-12`)) s0 = k;
  if (s0 < 0) throw new Error("실행 시작일(2009-12 말) 없음");
  console.log(`\n달력 ${N}일 ${cal[0]}~${lastDate}, 실행 시작일 ${cal[s0]}`);
  const rStock = (k: number): number => P[0][k] / P[0][k - 1] - 1;
  const rBond = (k: number): number => P[1][k] / P[1][k - 1] - 1;

  function sigma(k: number, n: number): number | null {
    if (k < n) return null;
    let s = 0, s2 = 0;
    for (let j = k - n + 1; j <= k; j++) { const r = rStock(j); s += r; s2 += r * r; }
    const m = s / n;
    return Math.sqrt(Math.max((s2 - n * m * m) / (n - 1), 0)) * Math.sqrt(ETF_TRADING_DAYS_PER_YEAR);
  }
  const targetW = (k: number, n: number): number | null => { const sg = sigma(k, n); return sg === null ? null : sg === 0 ? 1 : Math.min(1, VOL_TARGET_ANNUAL / sg); };

  function simulate(n: number, delay: boolean): { run: Run; firstSignal: string | null; signalsBefore: number } {
    const dates: string[] = [], ret: number[] = [], costFrac: number[] = [], reb: number[] = [], wStock: number[] = [];
    let stockV = 0, bondV = 0, prevV = 1, pending: number | null = null;
    let firstSignal: string | null = null, signalsBefore = 0;
    for (let k = s0; k < N; k++) {
      let c = 0, didReb = 0;
      const execute = (w: number): void => {
        const V = stockV + bondV;
        const dS = w * V - stockV, dB = (1 - w) * V - bondV;
        const buyN = Math.max(dS, 0) + Math.max(dB, 0), sellN = Math.max(-dS, 0) + Math.max(-dB, 0);
        const cost = (buyN + sellN) * COST, scale = (V - cost) / V;
        stockV = w * V * scale; bondV = (1 - w) * V * scale;
        c += cost / V; didReb = 1;
      };
      if (k === s0) {
        const w0 = targetW(k, n);
        if (w0 !== null) firstSignal = cal[k];
        const w = w0 ?? 1;
        stockV = w * (1 - COST); bondV = (1 - w) * (1 - COST); c = COST;
        dates.push(cal[k]); ret.push(0); costFrac.push(c); reb.push(0); wStock.push(stockV / (stockV + bondV)); prevV = stockV + bondV;
        continue;
      }
      stockV *= 1 + rStock(k); bondV *= 1 + rBond(k);
      if (delay && pending !== null) { execute(pending); pending = null; }
      if (isME(k)) {
        const w = targetW(k, n);
        if (w === null) signalsBefore++;
        else {
          if (firstSignal === null) firstSignal = cal[k];
          const cur = stockV / (stockV + bondV);
          if (Math.abs(w - cur) >= VOL_TARGET_REBALANCE_BAND) { if (delay) pending = w; else execute(w); }
        }
      }
      const V = stockV + bondV;
      dates.push(cal[k]); ret.push((V / prevV - 1) * 100); costFrac.push(c); reb.push(didReb); wStock.push(stockV / V);
      prevV = V;
    }
    return { run: { dates, ret, costFrac, reb, wStock }, firstSignal, signalsBefore };
  }
  const passive = (a: number): Run => ({ dates: cal.slice(s0), ret: cal.slice(s0).map((_, i) => (i === 0 ? 0 : ((a === 0 ? rStock(s0 + i) : rBond(s0 + i)) * 100))), costFrac: cal.slice(s0).map(() => 0), reb: cal.slice(s0).map(() => 0), wStock: cal.slice(s0).map(() => (a === 0 ? 1 : 0)) });
  const bh = passive(0), bond = passive(1);
  const sims = new Map<VarId, { base: ReturnType<typeof simulate>; delayed: ReturnType<typeof simulate> }>();
  for (const v of VOL_TARGET_VARIANTS) sims.set(v.id, { base: simulate(v.n, false), delayed: simulate(v.n, true) });
  console.log("\n첫 신호일과 신호 없던 월말 수 (무지연 실행):");
  for (const v of VOL_TARGET_VARIANTS) { const b = sims.get(v.id)!.base; console.log(`  ${v.id} (N=${v.n}): 첫 신호일 ${b.firstSignal ?? "없음"}, 신호 없어 069500 100%였던 s0 이후 월말 ${b.signalsBefore}개, s0 신호 ${b.firstSignal === cal[s0] ? "있음" : "없음"}`); }
  const kp = kospi.filter((p) => p.tradeDate >= cal[s0]);
  const kRun: Run = { dates: kp.slice(1).map((p) => p.tradeDate), ret: computeIndexDailyReturnsPct(kp as never), costFrac: [], reb: [], wStock: [] };

  // ---- 지표 ----
  const yearsOf = (w: Win): number => Math.max((Date.parse(w.to) - Date.parse(w.from)) / MS_DAY / 365.25, 1e-9);
  const inWin = (d: string, w: Win): boolean => d >= w.from && d <= w.to;
  function st(run: Run, win: Win): Stats {
    const idx: number[] = [];
    for (let i = 0; i < run.dates.length; i++) if (inWin(run.dates[i], win) && run.dates[i] > cal[s0]) idx.push(i);
    const r = idx.map((i) => run.ret[i]);
    const { totalReturnPct, mddPct } = computeCumulativeAndMdd(r);
    const cagr = computeCagrPct(totalReturnPct, win.from, win.to);
    const m = r.reduce((a, x) => a + x, 0) / Math.max(r.length, 1);
    const sd = Math.sqrt(r.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(r.length - 1, 1));
    return {
      cagr, mdd: mddPct, cm: mddPct > 0 ? cagr / mddPct : NaN, vol: sd * Math.sqrt(ETF_TRADING_DAYS_PER_YEAR),
      sharpe: sd > 0 ? (m * ETF_TRADING_DAYS_PER_YEAR) / (sd * Math.sqrt(ETF_TRADING_DAYS_PER_YEAR)) : NaN,
      avgW: run.wStock.length ? (idx.reduce((a, i) => a + run.wStock[i], 0) / Math.max(idx.length, 1)) * 100 : NaN,
      reb: run.reb.length ? idx.reduce((a, i) => a + run.reb[i], 0) / yearsOf(win) : NaN,
      cost: run.costFrac.length ? idx.reduce((a, i) => a + run.costFrac[i], 0) * 100 : NaN,
    };
  }
  const yearRet = (run: Run, y: number, win: Win): number => computeCumulativeAndMdd(run.ret.filter((_, i) => run.dates[i].startsWith(`${y}-`) && inWin(run.dates[i], win) && run.dates[i] > cal[s0])).totalReturnPct;
  const yearW = (run: Run, y: number, win: Win): number => { const v = run.wStock.filter((_, i) => run.dates[i].startsWith(`${y}-`) && inWin(run.dates[i], win) && run.dates[i] > cal[s0]); return (v.reduce((a, x) => a + x, 0) / Math.max(v.length, 1)) * 100; };

  const HEAD = "| 구분 | CAGR | MDD | 샤프 | CAGR÷MDD | 연변동성 | 평균 주식 비중 % | 연 리밸런싱 횟수 | 누적 비용 % | 지연 CAGR | 하락 %p | G1 | G2 | G3 | G4 |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|";
  const ref = (name: string, s: Stats, w?: string, reb?: string, cost?: string): string => `| ${name} | ${f2(s.cagr)} | ${f2(s.mdd)} | ${f2(s.sharpe)} | ${f2(s.cm)} | ${f2(s.vol)} | ${w ?? "-"} | ${reb ?? "-"} | ${cost ?? "-"} | | | | | | |`;
  const gatesOf = (x: Stats, b: Stats, drop: number): boolean[] => [x.cagr >= b.cagr - VOL_TARGET_G1_CAGR_MARGIN_PP, x.sharpe > b.sharpe, x.cm > b.cm, drop <= VOL_TARGET_G4_MAX_DELAY_DROP_PP];
  const table = (win: Win, vars: VarId[]): { id: VarId; s: Stats; g: boolean[] }[] => {
    const b = st(bh, win);
    console.log(HEAD);
    const out = vars.map((id) => {
      const { base, delayed } = sims.get(id)!;
      const s = st(base.run, win), sd = st(delayed.run, win), drop = s.cagr - sd.cagr, g = gatesOf(s, b, drop);
      console.log(`| ${id} | ${f2(s.cagr)} | ${f2(s.mdd)} | ${f2(s.sharpe)} | ${f2(s.cm)} | ${f2(s.vol)} | ${f2(s.avgW)} | ${f2(s.reb)} | ${f2(s.cost)} | ${f2(sd.cagr)} | ${f2(drop)} | ${g.map(ox).join(" | ")} |`);
      return { id, s, g };
    });
    console.log(ref("B&H(069500)", b, "100.00", "0.00", "0.00")); console.log(ref("114260 보유", st(bond, win), "0.00", "0.00", "0.00")); console.log(ref("KOSPI", st(kRun, win)));
    return out;
  };

  const learn: Win = { ...SEASON_LEARN };
  console.log(`\n=== (b) 학습 ${learn.from}~${learn.to} ===`);
  const L = table(learn, VOL_TARGET_VARIANTS.map((v) => v.id));
  const passers = L.filter((x) => x.g.every(Boolean));
  console.log("\n=== (c) 선택 ===");
  if (!passers.length) { console.log("선택 없음"); return finish(); }
  passers.sort((a, b) => b.s.sharpe - a.s.sharpe || a.s.reb - b.s.reb);
  const sel = passers[0].id;
  console.log(`전부 O 변형: ${passers.map((p) => p.id).join(", ")} → 선택 ${sel}`);
  const stage = (label: string, win: Win, withW: boolean): boolean => {
    console.log(`\n=== ${label} ${win.from}~${win.to} ===`);
    const R = table(win, [sel]);
    console.log(`연도별 수익률 %${withW ? "와 평균 주식 비중 %" : ""}\n| 연도 | ${sel} | B&H |${withW ? ` ${sel} 평균 주식 비중 |` : ""}\n|---|---|---|${withW ? "---|" : ""}`);
    for (let y = Number(win.from.slice(0, 4)); y <= Number(win.to.slice(0, 4)); y++) console.log(`| ${y} | ${f2(yearRet(sims.get(sel)!.base.run, y, win))} | ${f2(yearRet(bh, y, win))} |${withW ? ` ${f2(yearW(sims.get(sel)!.base.run, y, win))} |` : ""}`);
    return R[0].g.every(Boolean);
  };
  if (!stage("(d) 확인", { ...SEASON_CONFIRM }, true)) { console.log("\n확인 결과: 통과 아님 (홀드아웃 계산하지 않음)"); return finish(); }
  const holdOk = stage("(e) 홀드아웃", { from: SEASON_HOLDOUT_FROM, to: lastDate }, true);
  console.log(`\n최종: ${holdOk ? "통과" : "통과 아님"}`);
  finish();
}

function finish(): void {
  console.log(`\n(f) Supabase 읽은 행 ${JSON.stringify(dbRead)} 쓴 행 0 외부 요청 0 소요 ${((Date.now() - T0) / 1000).toFixed(1)}s`);
}

main().catch((e) => { console.error("실패:", e instanceof Error ? e.message : e); process.exit(1); });
