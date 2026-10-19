/**
 * [임시 연구 — 병합 금지, 읽기 전용, 외부 요청 0건] 시장 수급 전략 F1·F2 학습 선택 → 확인 → (통과 시) 홀드아웃 → (전부 O 시) R1~R3.
 * 정의는 research/flow-timing-prereg.md(사전 등록 196003f5 이후). DB 쓰기 없음.
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getIndexPriceSeries } from "@/lib/betaPriceHistoryStorage";
import { computeCumulativeAndMdd, computeCagrPct } from "@/lib/strategyBacktestSummary";
import { computeIndexDailyReturnsPct } from "@/lib/benchmarkSummary";
import { ETF_SPIKE_MIN_ABS_RET, ETF_SPIKE_MAX_NET_ABS, ETF_SPIKE_KOSPI_EXEMPT_RATIO, ETF_FEE_RATE, ETF_SLIPPAGE_RATE, ETF_TRADING_DAYS_PER_YEAR } from "@/lib/etfAllocationConfig";
import { SEASON_STOCK_CODE, SEASON_BOND_CODE, SEASON_RUN_START_YEAR, SEASON_LEARN, SEASON_CONFIRM, SEASON_HOLDOUT_FROM } from "@/lib/seasonalityConfig";
import { FLOW_SUM_DAYS, FLOW_R1_SUM_DAYS, FLOW_VARIANTS, FLOW_REDUCED_STOCK_WEIGHT, FLOW_G1_CAGR_MARGIN_PP, FLOW_G4_MAX_DELAY_DROP_PP, FLOW_R3_DRAWS, FLOW_R3_SEED, FLOW_R3_TOP_FRACTION, FLOW_INFO_END } from "@/lib/flowTimingConfig";

const T0 = Date.now();
const COST = ETF_FEE_RATE + ETF_SLIPPAGE_RATE;
const f2 = (x: number): string => (Number.isFinite(x) ? x.toFixed(2) : "-");
const ox = (b: boolean): string => (b ? "O" : "X");
const dbRead: Record<string, number> = {};
type VarId = (typeof FLOW_VARIANTS)[number]["id"];
interface Win { from: string; to: string }
interface Run { dates: string[]; ret: number[]; costFrac: number[]; trade: number[]; reduced: number[] }
interface Stats { cagr: number; mdd: number; sharpe: number; cm: number; vol: number; redMonths: number; trades: number; cost: number }
interface Flow { date: string; frgn: number | null; orgn: number | null }

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

async function readFlow(): Promise<Flow[]> {
  const rows: Flow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabaseAdmin.from("investor_flow_market").select("trade_date, frgn_ntby_amt, orgn_ntby_amt").eq("market", "KOSPI").order("trade_date").range(from, from + 999);
    if (error) throw new Error(`investor_flow_market 읽기 실패: ${error.message}`);
    for (const r of data ?? []) rows.push({ date: r.trade_date as string, frgn: r.frgn_ntby_amt === null ? null : Number(r.frgn_ntby_amt), orgn: r.orgn_ntby_amt === null ? null : Number(r.orgn_ntby_amt) });
    dbRead["investor_flow_market(KOSPI)"] = (dbRead["investor_flow_market(KOSPI)"] ?? 0) + (data?.length ?? 0);
    if (!data || data.length < 1000) break;
  }
  return rows;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

async function main(): Promise<void> {
  console.log(`시장 수급 전략 시작(읽기 전용): ${new Date().toISOString()} (사전등록 196003f5 이후)`);
  const kospi = await getIndexPriceSeries("KOSPI", "2008-01-01", "2099-12-31");
  dbRead["beta_price_history(KOSPI)"] = kospi.length;
  const kRetByDate = new Map<string, number>();
  for (let i = 1; i < kospi.length; i++) kRetByDate.set(kospi[i].tradeDate, kospi[i].closePrice / kospi[i - 1].closePrice - 1);
  const flow = await readFlow();
  console.log(`investor_flow_market KOSPI ${flow.length}행 ${flow[0]?.date}~${flow[flow.length - 1]?.date}`);

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

  // ---- 월말 신호 ----
  const flowDates = flow.map((f) => f.date);
  const flowIdxLE = (d: string): number => { let lo = 0, hi = flowDates.length - 1, ans = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (flowDates[m] <= d) { ans = m; lo = m + 1; } else hi = m - 1; } return ans; };
  const meIdx: number[] = [];
  for (let k = s0; k < N; k++) if (isME(k)) meIdx.push(k);
  const sumS = (k: number, n: number): { f: number; o: number } | null => {
    const j = flowIdxLE(cal[k]);
    if (j < n - 1) return null;
    let f = 0, o = 0;
    for (let i = j - n + 1; i <= j; i++) { const x = flow[i]; if (x.frgn === null || x.orgn === null) return null; f += x.frgn; o += x.orgn; }
    return { f, o };
  };
  const missingMeRow = meIdx.filter((k) => flowDates[flowIdxLE(cal[k])] !== cal[k]).length;
  console.log(`월말 신호일 ${meIdx.length}개(${cal[meIdx[0]]}~${cal[meIdx[meIdx.length - 1]]}), 월말 날짜 행이 투자자 표에 없는 월말 ${missingMeRow}개`);
  /** 목표 상태: 1 = 069500 100%, 0 = 축소, null = 신호 없음(직전 유지). */
  const target = (id: VarId, k: number, n: number): 0 | 1 | null => {
    const s = sumS(k, n);
    if (!s) return null;
    return id === "F1" ? (s.f > 0 ? 1 : 0) : (s.f < 0 && s.o < 0 ? 0 : 1);
  };
  const targetsFor = (id: VarId, n: number): (0 | 1 | null)[] => meIdx.map((k) => target(id, k, n));

  /** 월말 신호 목록(meIdx와 같은 길이)으로 시뮬레이션. */
  function simulate(sig: (0 | 1 | null)[], delay: boolean): Run {
    const dates: string[] = [], ret: number[] = [], costFrac: number[] = [], trade: number[] = [], reduced: number[] = [];
    const exec = new Map<number, 0 | 1>();
    let held: 0 | 1 = 1;
    for (let i = 0; i < meIdx.length; i++) {
      const want = sig[i];
      if (want !== null) exec.set(meIdx[i] + (delay ? 2 : 1), want); // 신호 없음 = 직전 상태 유지(체결 없음)
    }
    let stockV = 1, bondV = 0, prevV = 1;
    for (let k = s0; k < N; k++) {
      if (k === s0) { dates.push(cal[k]); ret.push(0); costFrac.push(0); trade.push(0); reduced.push(0); prevV = 1; continue; }
      const stateBefore = held;
      stockV *= 1 + rStock(k); bondV *= 1 + rBond(k);
      let c = 0, tr = 0;
      const want = exec.get(k);
      if (want !== undefined && want !== held) {
        const V = stockV + bondV, w = want === 1 ? 1 : FLOW_REDUCED_STOCK_WEIGHT;
        const dS = w * V - stockV, dB = (1 - w) * V - bondV;
        const turnover = Math.abs(dS) + Math.abs(dB);
        const cost = turnover * COST, scale = (V - cost) / V;
        stockV = w * V * scale; bondV = (1 - w) * V * scale;
        c = cost / V; tr = 1; held = want;
      }
      const V = stockV + bondV;
      dates.push(cal[k]); ret.push((V / prevV - 1) * 100); costFrac.push(c); trade.push(tr); reduced.push(stateBefore === 1 ? 0 : 1);
      prevV = V;
    }
    return { dates, ret, costFrac, trade, reduced };
  }
  const passive = (): Run => ({ dates: cal.slice(s0), ret: cal.slice(s0).map((_, i) => (i === 0 ? 0 : rStock(s0 + i) * 100)), costFrac: [], trade: [], reduced: [] });
  const bh = passive();
  const kp = kospi.filter((p) => p.tradeDate >= cal[s0]);
  const kRun: Run = { dates: kp.slice(1).map((p) => p.tradeDate), ret: computeIndexDailyReturnsPct(kp as never), costFrac: [], trade: [], reduced: [] };

  const sims = new Map<VarId, { sig: (0 | 1 | null)[]; base: Run; delayed: Run }>();
  for (const v of FLOW_VARIANTS) { const sig = targetsFor(v.id, FLOW_SUM_DAYS); sims.set(v.id, { sig, base: simulate(sig, false), delayed: simulate(sig, true) }); }

  // ---- 지표 ----
  const inWin = (d: string, w: Win): boolean => d >= w.from && d <= w.to;
  function st(run: Run, win: Win, sig?: (0 | 1 | null)[]): Stats {
    const idx: number[] = [];
    for (let i = 0; i < run.dates.length; i++) if (inWin(run.dates[i], win) && run.dates[i] > cal[s0]) idx.push(i);
    const r = idx.map((i) => run.ret[i]);
    const { totalReturnPct, mddPct } = computeCumulativeAndMdd(r);
    const cagr = computeCagrPct(totalReturnPct, win.from, win.to);
    const m = r.reduce((a, x) => a + x, 0) / Math.max(r.length, 1);
    const sd = Math.sqrt(r.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(r.length - 1, 1));
    let redMonths = NaN;
    if (sig) {
      let prevState: 0 | 1 = 1, nIn = 0, nRed = 0;
      for (let i = 0; i < meIdx.length; i++) {
        const cur: 0 | 1 = sig[i] ?? prevState; prevState = cur;
        if (inWin(cal[meIdx[i]], win) && cal[meIdx[i]] > cal[s0]) { nIn++; if (cur === 0) nRed++; }
      }
      redMonths = nIn ? (nRed / nIn) * 100 : NaN;
    }
    return {
      cagr, mdd: mddPct, cm: mddPct > 0 ? cagr / mddPct : NaN, vol: sd * Math.sqrt(ETF_TRADING_DAYS_PER_YEAR),
      sharpe: sd > 0 ? (m * ETF_TRADING_DAYS_PER_YEAR) / (sd * Math.sqrt(ETF_TRADING_DAYS_PER_YEAR)) : NaN,
      redMonths,
      trades: run.trade.length ? idx.reduce((a, i) => a + run.trade[i], 0) : NaN,
      cost: run.costFrac.length ? idx.reduce((a, i) => a + run.costFrac[i], 0) * 100 : NaN,
    };
  }
  const yearRet = (run: Run, y: number, win: Win): number => computeCumulativeAndMdd(run.ret.filter((_, i) => run.dates[i].startsWith(`${y}-`) && inWin(run.dates[i], win) && run.dates[i] > cal[s0])).totalReturnPct;

  const HEAD = "| 구분 | CAGR | MDD | 샤프 | CAGR÷MDD | 연변동성 | 축소 상태 월 비율 % | 전환 횟수 | 누적 비용 % | 지연 CAGR | 하락 %p | G1 | G2 | G3 | G4 |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|";
  const ref = (name: string, s: Stats): string => `| ${name} | ${f2(s.cagr)} | ${f2(s.mdd)} | ${f2(s.sharpe)} | ${f2(s.cm)} | ${f2(s.vol)} | - | - | - | | | | | | |`;
  const gatesOf = (x: Stats, b: Stats, drop: number): boolean[] => [x.cagr >= b.cagr - FLOW_G1_CAGR_MARGIN_PP, x.sharpe > b.sharpe, x.cm > b.cm, drop <= FLOW_G4_MAX_DELAY_DROP_PP];
  const table = (win: Win, vars: VarId[]): { id: VarId; s: Stats; g: boolean[] }[] => {
    const b = st(bh, win);
    console.log(HEAD);
    const out = vars.map((id) => {
      const { sig, base, delayed } = sims.get(id)!;
      const s = st(base, win, sig), sd = st(delayed, win), drop = s.cagr - sd.cagr, g = gatesOf(s, b, drop);
      console.log(`| ${id} | ${f2(s.cagr)} | ${f2(s.mdd)} | ${f2(s.sharpe)} | ${f2(s.cm)} | ${f2(s.vol)} | ${f2(s.redMonths)} | ${s.trades} | ${f2(s.cost)} | ${f2(sd.cagr)} | ${f2(drop)} | ${g.map(ox).join(" | ")} |`);
      return { id, s, g };
    });
    console.log(ref("B&H(069500)", b)); console.log(ref("KOSPI", st(kRun, win)));
    return out;
  };
  const yearly = (win: Win, vars: VarId[]): void => {
    console.log(`연도별 수익률 %\n| 연도 | ${vars.join(" | ")} | B&H |\n|---|${vars.map(() => "---|").join("")}---|`);
    for (let y = Number(win.from.slice(0, 4)); y <= Number(win.to.slice(0, 4)); y++) console.log(`| ${y} | ${vars.map((v) => f2(yearRet(sims.get(v)!.base, y, win))).join(" | ")} | ${f2(yearRet(bh, y, win))} |`);
  };

  // ---- 정보용 (학습 구간만) ----
  {
    console.log(`\n=== 정보용 (학습 구간만: 월말 ${cal[s0]} 이상, 다음 월말 ≤ ${FLOW_INFO_END}) ===`);
    for (const who of ["f", "o"] as const) {
      const pos: number[] = [], neg: number[] = []; let zero = 0, none = 0;
      for (let i = 0; i + 1 < meIdx.length; i++) {
        if (cal[meIdx[i + 1]] > FLOW_INFO_END) break;
        const s = sumS(meIdx[i], FLOW_SUM_DAYS);
        if (!s) { none++; continue; }
        const v = who === "f" ? s.f : s.o;
        const r = (P[0][meIdx[i + 1]] / P[0][meIdx[i]] - 1) * 100;
        if (v > 0) pos.push(r); else if (v < 0) neg.push(r); else zero++;
      }
      const mean = (a: number[]): number => a.reduce((x, y) => x + y, 0) / Math.max(a.length, 1);
      const vr = (a: number[]): number => a.reduce((x, y) => x + (y - mean(a)) ** 2, 0) / Math.max(a.length - 1, 1);
      const tv = (mean(pos) - mean(neg)) / Math.sqrt(vr(pos) / pos.length + vr(neg) / neg.length);
      console.log(`${who === "f" ? "외국인" : "기관"} S 부호별 다음 달 069500 수익률(%) (S=0 ${zero}개, 신호 없음 ${none}개 제외)\n| S 부호 | 평균 수익 % | 표본 수 |\n|---|---|---|\n| 양(>0) | ${f2(mean(pos))} | ${pos.length} |\n| 음(<0) | ${f2(mean(neg))} | ${neg.length} |\n| 차이(양−음) | ${f2(mean(pos) - mean(neg))} | t=${f2(tv)} |`);
    }
  }

  const learn: Win = { ...SEASON_LEARN };
  console.log(`\n=== (b) 학습 ${learn.from}~${learn.to} ===`);
  const L = table(learn, FLOW_VARIANTS.map((v) => v.id));
  yearly(learn, FLOW_VARIANTS.map((v) => v.id));
  const passers = L.filter((x) => x.g.every(Boolean));
  console.log("\n=== (c) 선택 ===");
  if (!passers.length) { console.log("선택 없음"); return finish(); }
  passers.sort((a, b) => b.s.sharpe - a.s.sharpe || a.s.trades - b.s.trades);
  const sel = passers[0].id;
  console.log(`전부 O 변형: ${passers.map((p) => p.id).join(", ")} → 선택 ${sel}`);
  const stage = (label: string, win: Win): boolean => {
    console.log(`\n=== ${label} ${win.from}~${win.to} ===`);
    const R = table(win, [sel]);
    yearly(win, [sel]);
    return R[0].g.every(Boolean);
  };
  if (!stage("(d) 확인", { ...SEASON_CONFIRM })) { console.log("\n확인 결과: 통과 아님 (홀드아웃 계산하지 않음)"); return finish(); }
  const holdWin: Win = { from: SEASON_HOLDOUT_FROM, to: lastDate };
  const holdOk = stage("(e) 홀드아웃", holdWin);
  if (!holdOk) { console.log("\n최종: 통과 아님 (R1~R3 계산하지 않음)"); return finish(); }

  // ---- 추가 검증 R1~R3 ----
  const full: Win = { from: SEASON_LEARN.from, to: lastDate };
  const bF = st(bh, full);
  console.log(`\n=== 추가 검증 R1~R3 (전 기간 ${full.from}~${full.to}, B&H CAGR ${f2(bF.cagr)} 샤프 ${f2(bF.sharpe)}) ===`);
  const selSim = sims.get(sel)!;
  const r1 = FLOW_R1_SUM_DAYS.map((n) => { const sig = targetsFor(sel, n); const s = st(simulate(sig, false), full, sig); return { n, cagr: s.cagr, ok: s.cagr >= bF.cagr }; });
  console.log("R1\n| 합산 일수 | 전 기간 CAGR | O/X |\n|---|---|---|");
  for (const x of r1) console.log(`| ${x.n} | ${f2(x.cagr)} | ${ox(x.ok)} |`);
  const r1ok = r1.every((x) => x.ok);

  // 축소 구간: 연속 축소 월말 신호
  const eff: (0 | 1)[] = []; { let p: 0 | 1 = 1; for (const t of selSim.sig) { p = t ?? p; eff.push(p); } }
  const runs: { a: number; b: number }[] = [];
  for (let i = 0; i < eff.length; i++) if (eff[i] === 0) { if (runs.length && runs[runs.length - 1].b === i - 1) runs[runs.length - 1].b = i; else runs.push({ a: i, b: i }); }
  console.log(`축소 구간 ${runs.length}개, 길이(월) ${runs.map((r) => r.b - r.a + 1).join(",")}`);
  // R2
  let r2ok: boolean | null = null;
  if (runs.length) {
    const excess = runs.map((r) => {
      const from = cal[meIdx[r.a] + 1], to = r.b + 1 < meIdx.length ? cal[meIdx[r.b + 1] + 1 < N ? meIdx[r.b + 1] + 1 : N - 1] : lastDate;
      const days = (run: Run): number => computeCumulativeAndMdd(run.ret.filter((_, i) => run.dates[i] > from && run.dates[i] <= to && run.dates[i] > cal[s0])).totalReturnPct;
      return { r, from, to, ex: days(selSim.base) - days(bh) };
    });
    excess.sort((x, y) => y.ex - x.ex);
    const top = excess[0];
    const sig2 = eff.map((t, i) => (i >= top.r.a && i <= top.r.b ? 1 : t)) as (0 | 1)[];
    const s2 = st(simulate(sig2, false), full, sig2);
    r2ok = s2.sharpe > bF.sharpe;
    console.log(`R2: 초과 수익 최대 구간 ${top.from}~${top.to} (월말 신호 ${cal[meIdx[top.r.a]]}~${cal[meIdx[top.r.b]]}, 초과 ${f2(top.ex)}%p) 를 100%로 바꾼 전 기간 샤프 ${f2(s2.sharpe)} vs B&H ${f2(bF.sharpe)} → ${ox(r2ok)}`);
  } else console.log("R2: 축소 구간 없음 (N/A)");
  // R3
  const lens = runs.map((r) => r.b - r.a + 1).sort((a, b) => b - a);
  const base = st(selSim.base, full, selSim.sig);
  let ge = 0, placed = 0;
  const rng = mulberry32(FLOW_R3_SEED);
  const nSig = meIdx.length;
  for (let d = 0; d < FLOW_R3_DRAWS; d++) {
    const occ = new Array<boolean>(nSig).fill(false);
    let okDraw = true;
    for (const len of lens) {
      let ok = false;
      for (let tries = 0; tries < 10_000 && !ok; tries++) {
        const a = Math.floor(rng() * (nSig - len + 1));
        let free = true;
        for (let i = Math.max(a - 1, 0); i <= Math.min(a + len, nSig - 1); i++) if (occ[i]) { free = false; break; }
        if (free) { for (let i = a; i < a + len; i++) occ[i] = true; ok = true; }
      }
      if (!ok) { okDraw = false; break; }
    }
    if (!okDraw) continue;
    placed++;
    const sigR = occ.map((o) => (o ? 0 : 1)) as (0 | 1)[];
    const s = st(simulate(sigR, false), full);
    if (s.sharpe >= base.sharpe) ge++;
  }
  const r3p = placed ? ge / placed : NaN;
  const r3ok = placed > 0 && r3p <= FLOW_R3_TOP_FRACTION;
  console.log(`R3: 배치 성공 ${placed}/${FLOW_R3_DRAWS}회, 실제 전 기간 샤프 ${f2(base.sharpe)}, 무작위 중 실제 이상 ${ge}회 (${f2(r3p * 100)}%) → ${ox(r3ok)}`);
  console.log(`\n최종: ${r1ok && r2ok !== false && r3ok ? "통과" : "통과 아님"} (R1 ${ox(r1ok)} R2 ${r2ok === null ? "N/A" : ox(r2ok)} R3 ${ox(r3ok)})`);
  finish();
}

function finish(): void {
  console.log(`\n(f) Supabase 읽은 행 ${JSON.stringify(dbRead)} 쓴 행 0 외부 요청 0 소요 ${((Date.now() - T0) / 1000).toFixed(1)}s`);
}

main().catch((e) => { console.error("실패:", e instanceof Error ? e.message : e); process.exit(1); });
