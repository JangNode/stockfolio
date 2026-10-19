/**
 * [임시 연구 — 병합 금지, 읽기 전용, 외부 요청 0건] 역발상 레버리지 L1 학습 → 확인 → (통과 시) 홀드아웃.
 * 정의는 research/drawdown-lever-prereg.md(사전 등록 b874119a 이후). DB 쓰기 없음.
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getIndexPriceSeries } from "@/lib/betaPriceHistoryStorage";
import { computeCumulativeAndMdd, computeCagrPct } from "@/lib/strategyBacktestSummary";
import { computeIndexDailyReturnsPct } from "@/lib/benchmarkSummary";
import { ETF_SPIKE_MIN_ABS_RET, ETF_SPIKE_MAX_NET_ABS, ETF_SPIKE_KOSPI_EXEMPT_RATIO, ETF_FEE_RATE, ETF_SLIPPAGE_RATE, ETF_TRADING_DAYS_PER_YEAR } from "@/lib/etfAllocationConfig";
import { SEASON_RUN_START_YEAR, SEASON_LEARN, SEASON_CONFIRM, SEASON_HOLDOUT_FROM } from "@/lib/seasonalityConfig";
import { DD_LEVER_STOCK_CODE, DD_LEVER_LEVER_CODE, DD_LEVER_HIGH_WINDOW_DAYS, DD_LEVER_ENTER_D, DD_LEVER_EXIT_D, DD_LEVER_EXPAND_LEVER_WEIGHT, DD_LEVER_G2_MDD_MARGIN_PP, DD_LEVER_G4_MAX_DELAY_DROP_PP } from "@/lib/drawdownLeverConfig";

const T0 = Date.now();
const COST = ETF_FEE_RATE + ETF_SLIPPAGE_RATE;
const MS_DAY = 86_400_000;
const f2 = (x: number): string => (Number.isFinite(x) ? x.toFixed(2) : "-");
const ox = (b: boolean): string => (b ? "O" : "X");
const dbRead: Record<string, number> = {};
interface Win { from: string; to: string }
interface Run { dates: string[]; ret: number[]; costFrac: number[]; sw: number[]; exp: number[] }
interface Stats { cagr: number; mdd: number; sharpe: number; cm: number; vol: number; expRatio: number; sw: number; cost: number }

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
  console.log(`역발상 레버리지 L1 시작(읽기 전용): ${new Date().toISOString()} (사전등록 b874119a 이후)`);
  const kospi = await getIndexPriceSeries("KOSPI", "2008-01-01", "2099-12-31");
  dbRead["beta_price_history(KOSPI)"] = kospi.length;
  const kRetByDate = new Map<string, number>();
  for (let i = 1; i < kospi.length; i++) kRetByDate.set(kospi[i].tradeDate, kospi[i].closePrice / kospi[i - 1].closePrice - 1);

  // ---- 정제 ----
  const raw = new Map<string, { date: string; px: number }[]>();
  for (const c of [DD_LEVER_STOCK_CODE, DD_LEVER_LEVER_CODE]) raw.set(c, await readEtf(c));
  const stkRaw = raw.get(DD_LEVER_STOCK_CODE)!;
  const stkRetByDate = new Map<string, number>();
  for (let i = 1; i < stkRaw.length; i++) stkRetByDate.set(stkRaw[i].date, stkRaw[i].px / stkRaw[i - 1].px - 1);
  const clean = new Map<string, { date: string; px: number }[]>();
  console.log("\n정제로 바꾼 날짜 (종목, 날짜, 원래 가격, 바꾼 가격):");
  let nChanged = 0;
  for (const code of [DD_LEVER_STOCK_CODE, DD_LEVER_LEVER_CODE]) {
    const s = raw.get(code)!;
    const r = s.map((x, i) => (i === 0 ? NaN : x.px / s[i - 1].px - 1));
    const out = s.map((x) => ({ ...x }));
    for (let t = 1; t + 1 < s.length; t++) {
      if (!(Math.abs(r[t]) > ETF_SPIKE_MIN_ABS_RET)) continue;
      if (!(Math.sign(r[t + 1]) === -Math.sign(r[t]))) continue;
      if (!(Math.abs((1 + r[t]) * (1 + r[t + 1]) - 1) < ETF_SPIKE_MAX_NET_ABS)) continue;
      const ref = code === DD_LEVER_STOCK_CODE ? kRetByDate.get(s[t].date) : stkRetByDate.get(s[t].date);
      if (ref !== undefined && Math.sign(ref) === Math.sign(r[t]) && Math.abs(ref) >= ETF_SPIKE_KOSPI_EXEMPT_RATIO * Math.abs(r[t])) continue;
      out[t].px = Math.sqrt(s[t - 1].px * s[t + 1].px);
      nChanged++;
      console.log(`  ${code} ${s[t].date} ${s[t].px} → ${out[t].px.toFixed(2)}`);
    }
    clean.set(code, out);
  }
  if (!nChanged) console.log("  없음");

  // ---- 달력·가격 ----
  const stk = clean.get(DD_LEVER_STOCK_CODE)!, lev = clean.get(DD_LEVER_LEVER_CODE)!;
  const cal = stk.map((x) => x.date);
  const N = cal.length, lastDate = cal[N - 1];
  const PS = Float64Array.from(stk.map((x) => x.px));
  const levMap = new Map(lev.map((x) => [x.date, x.px]));
  const PL = new Float64Array(N).fill(NaN);
  let prevL = NaN, firstLev = -1, ffDays = 0;
  for (let k = 0; k < N; k++) {
    const v = levMap.get(cal[k]);
    if (v !== undefined) { prevL = v; if (firstLev < 0) firstLev = k; PL[k] = v; }
    else if (firstLev >= 0) { PL[k] = prevL; ffDays++; }
  }
  const isME = (k: number): boolean => k + 1 < N && cal[k].slice(0, 7) !== cal[k + 1].slice(0, 7);
  let s0 = -1;
  for (let k = 0; k + 1 < N; k++) if (isME(k) && cal[k].startsWith(`${SEASON_RUN_START_YEAR}-12`)) s0 = k;
  if (s0 < 0) throw new Error("실행 시작일 없음");
  console.log(`\n달력(069500) ${N}일 ${cal[0]}~${lastDate}, 실행 시작일 ${cal[s0]}, 122630 첫 행 ${cal[firstLev]}, 상장 후 122630 행 없어 이월한 날 ${ffDays}일`);
  const rS = (k: number): number => PS[k] / PS[k - 1] - 1;
  const rL = (k: number): number => (k >= 1 && PL[k] > 0 && PL[k - 1] > 0 ? PL[k] / PL[k - 1] - 1 : 0);

  // ---- 신호 ----
  const D = new Float64Array(N).fill(NaN);
  const W = DD_LEVER_HIGH_WINDOW_DAYS;
  for (let k = W - 1; k < N; k++) { let hi = -Infinity; for (let j = k - W + 1; j <= k; j++) if (PS[j] > hi) hi = PS[j]; D[k] = PS[k] / hi - 1; }
  const sig = new Array<number>(N).fill(0);
  const suppressed: number[] = [];
  let state = 0;
  for (let k = s0; k < N; k++) {
    if (state === 0 && D[k] <= DD_LEVER_ENTER_D) { if (firstLev >= 0 && k >= firstLev) state = 1; else suppressed.push(k); }
    else if (state === 1 && D[k] >= DD_LEVER_EXIT_D) state = 0;
    sig[k] = state;
  }
  console.log(`122630 데이터 없어 무시한 확대 신호일: ${suppressed.length}일${suppressed.length ? ` (첫 ${cal[suppressed[0]]}, 마지막 ${cal[suppressed[suppressed.length - 1]]})` : ""}`);

  function simulate(delay: boolean): Run {
    const dates: string[] = [], ret: number[] = [], costFrac: number[] = [], sw: number[] = [], exp: number[] = [];
    let sV = 0, lV = 0, prevV = 1;
    const pos = (k: number): number => (k === s0 ? sig[k] : delay ? sig[k - 1] : sig[k]);
    for (let k = s0; k < N; k++) {
      let c = 0, sw1 = 0;
      if (k === s0) {
        const p = pos(k), wl = p === 1 ? DD_LEVER_EXPAND_LEVER_WEIGHT : 0;
        sV = (1 - wl) * (1 - COST); lV = wl * (1 - COST); c = COST;
        dates.push(cal[k]); ret.push(0); costFrac.push(c); sw.push(0); exp.push(p); prevV = sV + lV;
        continue;
      }
      sV *= 1 + rS(k); lV *= 1 + rL(k);
      const p = pos(k), pp = pos(k - 1);
      if (p !== pp) {
        const V = sV + lV;
        if (p === 1) { const half = V * (1 - DD_LEVER_EXPAND_LEVER_WEIGHT); const cost = V * DD_LEVER_EXPAND_LEVER_WEIGHT * 2 * COST; const scale = (V - cost) / V; sV = half * scale; lV = V * DD_LEVER_EXPAND_LEVER_WEIGHT * scale; c = cost / V; }
        else { const cost = lV * 2 * COST; const scale = (V - cost) / V; sV = (sV + lV) * scale; lV = 0; c = cost / V; }
        sw1 = 1;
      }
      const V = sV + lV;
      dates.push(cal[k]); ret.push((V / prevV - 1) * 100); costFrac.push(c); sw.push(sw1); exp.push(p);
      prevV = V;
    }
    return { dates, ret, costFrac, sw, exp };
  }
  const base = simulate(false), delayed = simulate(true);
  const passiveRun = (f: (k: number) => number): Run => ({ dates: cal.slice(s0), ret: cal.slice(s0).map((_, i) => (i === 0 ? 0 : f(s0 + i) * 100)), costFrac: cal.slice(s0).map(() => 0), sw: cal.slice(s0).map(() => 0), exp: cal.slice(s0).map(() => 0) });
  const bh = passiveRun(rS), levHold = passiveRun(rL);
  const kp = kospi.filter((p) => p.tradeDate >= cal[s0]);
  const kRun: Run = { dates: kp.slice(1).map((p) => p.tradeDate), ret: computeIndexDailyReturnsPct(kp as never), costFrac: [], sw: [], exp: [] };

  // ---- 지표 ----
  const yearsOf = (w: Win): number => Math.max((Date.parse(w.to) - Date.parse(w.from)) / MS_DAY / 365.25, 1e-9);
  void yearsOf;
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
      expRatio: run.exp.length ? (idx.reduce((a, i) => a + run.exp[i], 0) / Math.max(idx.length, 1)) * 100 : NaN,
      sw: run.sw.length ? idx.reduce((a, i) => a + run.sw[i], 0) : NaN,
      cost: run.costFrac.length ? idx.reduce((a, i) => a + run.costFrac[i], 0) * 100 : NaN,
    };
  }
  const yearRet = (run: Run, y: number, win: Win): number => computeCumulativeAndMdd(run.ret.filter((_, i) => run.dates[i].startsWith(`${y}-`) && inWin(run.dates[i], win) && run.dates[i] > cal[s0])).totalReturnPct;
  const compound = (run: Run, a: number, b: number): number => (run.ret.slice(a - s0, b - s0 + 1).reduce((p, x) => p * (1 + x / 100), 1) - 1) * 100;

  const HEAD = "| 구분 | CAGR | MDD | 샤프 | CAGR÷MDD | 연변동성 | 확대 상태 일수 비율 % | 전환 횟수 | 누적 비용 % | 지연 CAGR | 하락 %p | G1 | G2 | G3 | G4 |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|";
  const ref = (name: string, s: Stats): string => `| ${name} | ${f2(s.cagr)} | ${f2(s.mdd)} | ${f2(s.sharpe)} | ${f2(s.cm)} | ${f2(s.vol)} | - | - | - | | | | | | |`;
  const stage = (label: string, win: Win): boolean => {
    console.log(`\n=== ${label} ${win.from}~${win.to} ===`);
    const b = st(bh, win), s = st(base, win), sd = st(delayed, win), drop = s.cagr - sd.cagr;
    const g = [s.cagr > b.cagr, s.mdd <= b.mdd + DD_LEVER_G2_MDD_MARGIN_PP, s.cm >= b.cm, drop <= DD_LEVER_G4_MAX_DELAY_DROP_PP];
    console.log(HEAD);
    console.log(`| L1 | ${f2(s.cagr)} | ${f2(s.mdd)} | ${f2(s.sharpe)} | ${f2(s.cm)} | ${f2(s.vol)} | ${f2(s.expRatio)} | ${s.sw} | ${f2(s.cost)} | ${f2(sd.cagr)} | ${f2(drop)} | ${g.map(ox).join(" | ")} |`);
    console.log(ref("B&H(069500)", b)); console.log(ref("122630 보유(상장 전 미보유)", st(levHold, win))); console.log(ref("KOSPI", st(kRun, win)));
    return g.every(Boolean);
  };
  const stages: { label: string; win: Win }[] = [{ label: "(b) 학습", win: { ...SEASON_LEARN } }, { label: "(b) 확인", win: { ...SEASON_CONFIRM } }, { label: "(b) 홀드아웃", win: { from: SEASON_HOLDOUT_FROM, to: lastDate } }];
  let lastEnd = "", passedAll = true, ran = 0;
  for (const sg of stages) {
    ran++; lastEnd = sg.win.to;
    if (!stage(sg.label, sg.win)) { passedAll = false; console.log(`\n${sg.label} 결과: 하나 이상 X — 여기서 종료${ran < 3 ? " (다음 단계 계산하지 않음)" : ""}`); break; }
  }
  if (passedAll) console.log("\n최종: 조건부 후보 (학습·확인·홀드아웃 전부 O — 사전 고지에 따라 독립 검증으로 보지 않음)");

  // ---- (c) 확대 구간 ----
  const endK = (() => { let e = s0; for (let k = s0; k < N; k++) if (cal[k] <= lastEnd) e = k; return e; })();
  console.log(`\n=== (c) 확대 구간 (무지연 실행, 진입일 ≤ ${lastEnd}) ===\n| 진입일 | 진입 시 D % | 복귀일 | 기간 일수(달력) | L1 수익 % | B&H 수익 % |\n|---|---|---|---|---|---|`);
  let nEp = 0;
  for (let k = s0 + 1; k <= endK; k++) {
    if (base.exp[k - s0] === 1 && base.exp[k - 1 - s0] === 0) {
      let x = -1;
      for (let j = k + 1; j < N; j++) if (base.exp[j - s0] === 0) { x = j; break; }
      const open = x < 0 || x > endK, endIdx = open ? endK : x;
      nEp++;
      console.log(`| ${cal[k]} | ${f2(D[k] * 100)} | ${open ? `미복귀(단계 끝 ${cal[endK]} 기준)` : cal[x]} | ${Math.round((Date.parse(cal[endIdx]) - Date.parse(cal[k])) / MS_DAY)} | ${f2(compound(base, k, endIdx))} | ${f2(compound(bh, k, endIdx))} |`);
    }
  }
  if (!nEp) console.log("| (해당 구간 없음) | | | | | |");
  if (base.exp[0] === 1) console.log(`참고: 실행 시작일(${cal[s0]})에 이미 확대 상태로 진입`);

  // ---- (d) 연도별 ----
  const lastWin = stages[ran - 1].win;
  console.log("\n=== (d) 연도별 수익률 % (계산한 단계까지) ===\n| 연도 | L1 | B&H |\n|---|---|---|");
  for (let y = 2010; y <= Number(lastWin.to.slice(0, 4)); y++) { const w: Win = { from: `${y}-01-01`, to: y === Number(lastWin.to.slice(0, 4)) ? lastWin.to : `${y}-12-31` }; console.log(`| ${y} | ${f2(yearRet(base, y, w))} | ${f2(yearRet(bh, y, w))} |`); }
  console.log(`\n(e) Supabase 읽은 행 ${JSON.stringify(dbRead)} 쓴 행 0 외부 요청 0 소요 ${((Date.now() - T0) / 1000).toFixed(1)}s`);
}

main().catch((e) => { console.error("실패:", e instanceof Error ? e.message : e); process.exit(1); });
