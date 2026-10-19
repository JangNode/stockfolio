/**
 * [임시 연구 — 병합 금지, 읽기 전용, 외부 요청 0건] 계절성 전략 H1(핼러윈)·H2(월말·월초) 학습 선택 → 확인 → (통과 시) 홀드아웃.
 * 정의는 research/seasonality-prereg.md(사전 등록 2f69f8ed 이후). DB 쓰기 없음.
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getIndexPriceSeries } from "@/lib/betaPriceHistoryStorage";
import { computeCumulativeAndMdd, computeCagrPct } from "@/lib/strategyBacktestSummary";
import { computeIndexDailyReturnsPct } from "@/lib/benchmarkSummary";
import { ETF_SPIKE_MIN_ABS_RET, ETF_SPIKE_MAX_NET_ABS, ETF_SPIKE_KOSPI_EXEMPT_RATIO, ETF_FEE_RATE, ETF_SLIPPAGE_RATE, ETF_TRADING_DAYS_PER_YEAR } from "@/lib/etfAllocationConfig";
import {
  SEASON_STOCK_CODE, SEASON_BOND_CODE, SEASON_H1_BUY_MONTH, SEASON_H1_SELL_MONTH, SEASON_H2_ENTRY_BEFORE_DAYS, SEASON_H2_EXIT_AFTER_DAYS, SEASON_RUN_START_YEAR,
  SEASON_LEARN, SEASON_CONFIRM, SEASON_HOLDOUT_FROM, SEASON_G1_CAGR_MARGIN_PP, SEASON_G4_MAX_DELAY_DROP_PP, SEASON_WINTER_MONTHS,
} from "@/lib/seasonalityConfig";

const T0 = Date.now();
const COST_SWAP = 2 * (ETF_FEE_RATE + ETF_SLIPPAGE_RATE);
const MS_DAY = 86_400_000;
const f2 = (x: number): string => (Number.isFinite(x) ? x.toFixed(2) : "-");
const f3 = (x: number): string => (Number.isFinite(x) ? x.toFixed(3) : "-");
const ox = (b: boolean): string => (b ? "O" : "X");
const dbRead: Record<string, number> = {};
type VarId = "H1" | "H2";
interface Win { from: string; to: string }
interface Run { dates: string[]; ret: number[]; costFrac: number[]; sw: number[] }
interface Stats { cagr: number; mdd: number; sharpe: number; cm: number; vol: number; sw: number; cost: number }

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
  console.log(`계절성 전략 시작(읽기 전용): ${new Date().toISOString()} (사전등록 2f69f8ed 이후)`);
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

  // ---- 신호 ----
  const sigH1 = new Array<number>(N).fill(0), sigH2 = new Array<number>(N).fill(0);
  sigH1[s0] = 1; // 12월 말 = 11~4월 구간
  for (let k = s0 + 1; k < N; k++) {
    sigH1[k] = sigH1[k - 1];
    if (isME(k)) { const m = Number(cal[k].slice(5, 7)); if (m === SEASON_H1_BUY_MONTH) sigH1[k] = 1; else if (m === SEASON_H1_SELL_MONTH) sigH1[k] = 0; }
  }
  const holdDaysH2 = new Set<number>(); // 069500 보유 수익률이 반영되는 날 (L−3..L+3)
  for (let L = s0; L < N; L++) {
    if (!isME(L)) continue;
    for (let k = L - SEASON_H2_ENTRY_BEFORE_DAYS; k <= L + SEASON_H2_EXIT_AFTER_DAYS - 1; k++) if (k >= s0 && k < N) sigH2[k] = 1;
    for (let k = L - SEASON_H2_ENTRY_BEFORE_DAYS + 1; k <= L + SEASON_H2_EXIT_AFTER_DAYS; k++) if (k > s0 && k < N) holdDaysH2.add(k);
  }
  sigH2[s0] = 1;

  function simulate(sig: number[], delay: boolean): Run {
    const dates: string[] = [], ret: number[] = [], costFrac: number[] = [], sw: number[] = [];
    let pos = sig[s0];
    for (let k = s0; k < N; k++) {
      if (k === s0) { dates.push(cal[k]); ret.push(0); costFrac.push(COST_SWAP / 2); sw.push(0); continue; }
      const target = delay ? sig[k - 1] : sig[k];
      const r = pos === 1 ? rStock(k) : rBond(k);
      const sw1 = target !== pos ? 1 : 0;
      const c = sw1 * COST_SWAP;
      dates.push(cal[k]); ret.push(((1 + r) * (1 - c) - 1) * 100); costFrac.push(c); sw.push(sw1);
      pos = target;
    }
    return { dates, ret, costFrac, sw };
  }
  const passive = (a: number): Run => ({ dates: cal.slice(s0), ret: cal.slice(s0).map((_, i) => (i === 0 ? 0 : ((a === 0 ? rStock(s0 + i) : rBond(s0 + i)) * 100))), costFrac: cal.slice(s0).map(() => 0), sw: cal.slice(s0).map(() => 0) });
  const bh = passive(0), bond = passive(1);
  const sims = new Map<VarId, { base: Run; delayed: Run }>([["H1", { base: simulate(sigH1, false), delayed: simulate(sigH1, true) }], ["H2", { base: simulate(sigH2, false), delayed: simulate(sigH2, true) }]]);
  const kp = kospi.filter((p) => p.tradeDate >= cal[s0]);
  const kRun: Run = { dates: kp.slice(1).map((p) => p.tradeDate), ret: computeIndexDailyReturnsPct(kp as never), costFrac: [], sw: [] };

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
      sw: run.sw.length ? idx.reduce((a, i) => a + run.sw[i], 0) / yearsOf(win) : NaN,
      cost: run.costFrac.length ? idx.reduce((a, i) => a + run.costFrac[i], 0) * 100 : NaN,
    };
  }
  const yearRet = (run: Run, y: number, win: Win): number =>
    computeCumulativeAndMdd(run.ret.filter((_, i) => run.dates[i].startsWith(`${y}-`) && inWin(run.dates[i], win) && run.dates[i] > cal[s0])).totalReturnPct;

  const HEAD = "| 구분 | CAGR | MDD | 샤프 | CAGR÷MDD | 연변동성 | 연 전환 횟수 | 누적 비용 % | 지연 CAGR | 하락 %p | G1 | G2 | G3 | G4 |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|";
  const ref = (name: string, s: Stats, sw?: string, cost?: string): string => `| ${name} | ${f2(s.cagr)} | ${f2(s.mdd)} | ${f2(s.sharpe)} | ${f2(s.cm)} | ${f2(s.vol)} | ${sw ?? "-"} | ${cost ?? "-"} | | | | | | |`;
  const gatesOf = (x: Stats, b: Stats, drop: number): boolean[] => [x.cagr >= b.cagr - SEASON_G1_CAGR_MARGIN_PP, x.sharpe > b.sharpe, x.cm > b.cm, drop <= SEASON_G4_MAX_DELAY_DROP_PP];
  const table = (win: Win, vars: VarId[]): { id: VarId; s: Stats; g: boolean[] }[] => {
    const b = st(bh, win);
    console.log(HEAD);
    const out = vars.map((id) => {
      const { base, delayed } = sims.get(id)!;
      const s = st(base, win), sd = st(delayed, win), drop = s.cagr - sd.cagr, g = gatesOf(s, b, drop);
      console.log(`| ${id} | ${f2(s.cagr)} | ${f2(s.mdd)} | ${f2(s.sharpe)} | ${f2(s.cm)} | ${f2(s.vol)} | ${f2(s.sw)} | ${f2(s.cost)} | ${f2(sd.cagr)} | ${f2(drop)} | ${g.map(ox).join(" | ")} |`);
      return { id, s, g };
    });
    console.log(ref("B&H(069500)", b, "0.00", "0.00")); console.log(ref("114260 보유", st(bond, win), "0.00", "0.00")); console.log(ref("KOSPI", st(kRun, win)));
    return out;
  };

  const learn: Win = { ...SEASON_LEARN };
  console.log(`\n=== (b) 학습 ${learn.from}~${learn.to} ===`);
  const L = table(learn, ["H1", "H2"]);

  // ---- (c) 정보용 통계 ----
  {
    const idxIn: number[] = [];
    for (let k = s0 + 1; k < N; k++) if (inWin(cal[k], learn)) idxIn.push(k);
    const years = [...new Set(idxIn.map((k) => cal[k].slice(0, 4)))];
    const winter = new Set<number>(SEASON_WINTER_MONTHS);
    const yr = (y: string, w: boolean): number => (idxIn.filter((k) => cal[k].startsWith(y) && winter.has(Number(cal[k].slice(5, 7))) === w).reduce((p, k) => p * (1 + rStock(k)), 1) - 1) * 100;
    const avgW = years.reduce((a, y) => a + yr(y, true), 0) / years.length, avgS = years.reduce((a, y) => a + yr(y, false), 0) / years.length;
    console.log(`\n=== (c) 정보용 (학습 구간, 069500 정제 수익률) ===\n연평균 수익률 %: 11~4월(해당 연도 11·12월+1~4월) ${f2(avgW)} | 5~10월 ${f2(avgS)} | 연도 수 ${years.length}`);
    const a = idxIn.filter((k) => holdDaysH2.has(k)).map((k) => rStock(k) * 100), b = idxIn.filter((k) => !holdDaysH2.has(k)).map((k) => rStock(k) * 100);
    const mean = (x: number[]): number => x.reduce((p, q) => p + q, 0) / x.length;
    const vr = (x: number[]): number => { const m = mean(x); return x.reduce((p, q) => p + (q - m) ** 2, 0) / (x.length - 1); };
    const t = (mean(a) - mean(b)) / Math.sqrt(vr(a) / a.length + vr(b) / b.length);
    console.log(`일평균 수익률 %: 월말·월초 창(L−3…L+3) ${f3(mean(a))} (n=${a.length}) | 나머지 ${f3(mean(b))} (n=${b.length}) | Welch t = ${f2(t)}`);
  }

  const passers = L.filter((x) => x.g.every(Boolean));
  console.log("\n=== (d) 선택 ===");
  if (!passers.length) { console.log("선택 없음"); return finish(); }
  passers.sort((a, b) => b.s.sharpe - a.s.sharpe || a.s.sw - b.s.sw);
  const sel = passers[0].id;
  console.log(`전부 O 변형: ${passers.map((p) => p.id).join(", ")} → 선택 ${sel}`);
  const stage = (label: string, win: Win): boolean => {
    console.log(`\n=== ${label} ${win.from}~${win.to} ===`);
    const R = table(win, [sel]);
    console.log(`연도별 수익률 %\n| 연도 | ${sel} | B&H |\n|---|---|---|`);
    for (let y = Number(win.from.slice(0, 4)); y <= Number(win.to.slice(0, 4)); y++) console.log(`| ${y} | ${f2(yearRet(sims.get(sel)!.base, y, win))} | ${f2(yearRet(bh, y, win))} |`);
    return R[0].g.every(Boolean);
  };
  if (!stage("(e) 확인", { ...SEASON_CONFIRM })) { console.log("\n확인 결과: 통과 아님 (홀드아웃 계산하지 않음)"); return finish(); }
  const holdOk = stage("(f) 홀드아웃", { from: SEASON_HOLDOUT_FROM, to: lastDate });
  console.log(`\n최종: ${holdOk ? "통과" : "통과 아님"}`);
  finish();
}

function finish(): void {
  console.log(`\n(g) Supabase 읽은 행 ${JSON.stringify(dbRead)} 쓴 행 0 외부 요청 0 소요 ${((Date.now() - T0) / 1000).toFixed(1)}s`);
}

main().catch((e) => { console.error("실패:", e instanceof Error ? e.message : e); process.exit(1); });
