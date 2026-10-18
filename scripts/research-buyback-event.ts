/**
 * [임시 연구 — 병합 금지, 읽기 전용, 외부 요청 0건] 자사주 공시 이벤트 전략 4변형 (T99~102, 홀드아웃 시 T103).
 * 사전 등록: research/buyback-event-prereg.md (커밋 1395f8b). 정의·선택 규칙은 그 문서가 고정한다. 숫자와 표, O/X만 출력한다.
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
import { simulateD4, type Sk as D4Sk } from "./research-audit-peg";

const T0 = Date.now();
const TODAY = new Date().toISOString().slice(0, 10);
const CAP_EOK = 5000;
const PERIOD_START = "2010-01-01";
const LEARN = { from: "2015-01-01", to: "2020-12-31" };
const CONFIRM = { from: "2021-01-01", to: "9999-12-31" };
const HOLD = { from: "2010-02-01", to: "2014-12-31" };
const DUP_DAYS = 30;
const MIX_D4_W = 0.8;
const G3_MARGIN = 2.0, G5_MAX_DROP = 1.0;
const HORIZONS = [1, 2, 3, 5, 10, 15, 20, 30, 40, 50, 60];
const MS_DAY = 86_400_000;
const f2 = (x: number): string => (Number.isFinite(x) ? x.toFixed(2) : "-");
const ox = (b: boolean): string => (b ? "O" : "X");
const dayDiff = (a: string, b: string): number => (Date.parse(b) - Date.parse(a)) / MS_DAY;
const dbRead: Record<string, number> = {};
interface Win { from: string; to: string }
interface Variant { name: string; types: ("direct" | "trust")[]; H: number }
const VARIANTS: Variant[] = [
  { name: "E1", types: ["direct"], H: 20 }, { name: "E2", types: ["direct"], H: 60 },
  { name: "E3", types: ["direct", "trust"], H: 20 }, { name: "E4", types: ["direct", "trust"], H: 60 },
];
interface Ev { rcept_no: string; rcept_dt: string; corp_code: string; stock_code: string | null; event_type: "direct" | "trust" }
interface Sk extends D4Sk { last: string }

async function main(): Promise<void> {
  console.log(`자사주 공시 이벤트 전략 4변형 시작(읽기 전용): ${new Date().toISOString()} (사전등록 1395f8b 이후)`);
  const adjustments = await loadAppliedAdjustments();
  dbRead["stock_price_adjustment_events(applied)"] = [...adjustments.values()].reduce((a, l) => a + l.length, 0);
  const series = await loadAllStockSeriesFromParquet(2010, new Date().getUTCFullYear(), adjustments);
  const kospi = await getIndexPriceSeries("KOSPI", "2009-12-01", TODAY);
  dbRead["beta_price_history(KOSPI)"] = kospi.length;

  const stocks: Sk[] = [];
  const calSet = new Set<string>();
  const pricesByStock = new Map<string, { date: string; close: number }[]>();
  for (const [code, rows] of series) {
    for (const r of rows) if (r.tradeDate >= PERIOD_START) calSet.add(r.tradeDate);
    stocks.push({ code, dates: rows.map((r) => r.tradeDate), close: Float64Array.from(rows.map((r) => r.closePrice)), mcap: Float64Array.from(rows.map((r) => r.marketCapEok)), avgTv: computeTrailingAvgTradingValue(rows, PIT_LIQUIDITY_LOOKBACK_DAYS), idx: new Map(rows.map((r, i) => [r.tradeDate, i])), last: rows[rows.length - 1].tradeDate });
    pricesByStock.set(code, rows.map((r) => ({ date: r.tradeDate, close: r.closePrice })));
    series.delete(code);
  }
  stocks.sort((a, b) => (a.code < b.code ? -1 : 1));
  const byCode = new Map(stocks.map((s) => [s.code, s]));
  const CALF = [...calSet].sort();
  const dataEnd = CALF[CALF.length - 1];
  const calPos = new Map(CALF.map((d, i) => [d, i]));
  const endedBefore = new Date(Date.parse(CALF[CALF.length - 1]) - 14 * MS_DAY).toISOString().slice(0, 10);
  const monthEndSet = new Set<string>();
  for (let k = 0; k + 1 < CALF.length; k++) if (CALF[k].slice(0, 7) !== CALF[k + 1].slice(0, 7)) monthEndSet.add(CALF[k]);
  console.log(`종목 ${stocks.length}개, 거래일 ${CALF.length}일 ${CALF[0]}~${dataEnd}`);

  // ---- 기준선 ----
  const d4Sim = simulateD4(stocks, CALF);
  if (d4Sim.dates.length !== CALF.length) throw new Error("D4 날짜 정렬 불일치");
  const ew = simulateUniverseMonthlyRebalance(pricesByStock, CALF, PERIOD_START, (code, date) => { const sk = byCode.get(code); const i = sk?.idx.get(date); return sk !== undefined && i !== undefined && Number.isFinite(sk.avgTv[i]) && sk.mcap[i] >= CAP_EOK && sk.avgTv[i] >= PIT_MIN_AVG_TRADING_VALUE_WON; }, true);
  const kp = kospi.filter((p) => p.tradeDate >= PERIOD_START);
  const kDates = kp.slice(1).map((p) => p.tradeDate);
  const kRets = computeIndexDailyReturnsPct(kp as never);
  const ewLog = new Float64Array(CALF.length + 1);
  for (let i = 0; i < CALF.length; i++) ewLog[i + 1] = ewLog[i] + Math.log(1 + ew[i] / 100);

  const buyRate = computeEffectiveBuyPrice(1) - 1;
  const sellRateOn = (d: string): number => 1 - computeEffectiveSellPrice(1, d, "KR");

  // ---- 이벤트 ----
  const evRaw: Ev[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabaseAdmin.from("dart_buyback_events").select("rcept_no, rcept_dt, corp_code, stock_code, event_type, is_amendment, is_extension").eq("is_amendment", false).eq("is_extension", false).order("rcept_dt").order("rcept_no").range(from, from + 999);
    if (error) throw new Error(error.message);
    evRaw.push(...(data ?? []) as Ev[]);
    dbRead["dart_buyback_events(원본)"] = (dbRead["dart_buyback_events(원본)"] ?? 0) + (data?.length ?? 0);
    if ((data?.length ?? 0) < 1000) break;
  }
  console.log(`원본 이벤트 ${evRaw.length}건 로드`);

  // ---- 유니버스 캐시 ----
  interface Univ { set: Set<string>; rank: Map<string, number>; n: number }
  const univCache = new Map<string, Univ>();
  const univAt = (d0: string): Univ => {
    let u = univCache.get(d0);
    if (u) return u;
    const el: { code: string; m: number }[] = [];
    for (const sk of stocks) { const i = sk.idx.get(d0); if (i === undefined || i < 1 || !(sk.mcap[i - 1] >= CAP_EOK) || !(sk.avgTv[i] >= PIT_MIN_AVG_TRADING_VALUE_WON)) continue; el.push({ code: sk.code, m: sk.mcap[i] }); }
    el.sort((a, b) => b.m - a.m || (a.code < b.code ? -1 : 1));
    u = { set: new Set(el.map((x) => x.code)), rank: new Map(el.map((x, r) => [x.code, r])), n: el.length };
    univCache.set(d0, u);
    return u;
  };
  /** rcept_dt 미만인 마지막 거래일 / rcept_dt 초과인 첫 거래일 */
  const lastBefore = (d: string): string | null => { let lo = 0, hi = CALF.length - 1, f = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (CALF[m] < d) { f = m; lo = m + 1; } else hi = m - 1; } return f >= 0 ? CALF[f] : null; };
  const firstAfter = (d: string): number => { let lo = 0, hi = CALF.length - 1, f = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (CALF[m] > d) { f = m; hi = m - 1; } else lo = m + 1; } return f; };

  // ---- BB 시뮬레이션 ----
  interface Trade { code: string; E: string; X: string; iE: number; tercile: number; forced: boolean; truncated: boolean }
  interface Counts { raw: number; outUniverse: number; outNoMap: number; dup: number; holding: number; noEntry: number; adopted: number }
  interface BB { dates: string[]; ret: number[]; costFrac: number[]; nAlive: number[]; trades: Trade[]; counts: Counts; entries: number; exitsWithCost: number }
  const winDays = (w: Win): number[] => { const o: number[] = []; for (let k = 0; k < CALF.length; k++) if (CALF[k] >= w.from && CALF[k] <= w.to) o.push(k); return o; };
  function simulateBB(v: Variant, extraDelay: number, w: Win): BB {
    const days = winDays(w);
    const firstK = days[0], lastK = days[days.length - 1];
    const counts: Counts = { raw: 0, outUniverse: 0, outNoMap: 0, dup: 0, holding: 0, noEntry: 0, adopted: 0 };
    const trades: Trade[] = [];
    const lastAdopted = new Map<string, string>();
    const holdUntil = new Map<string, string>();
    const sums = new Float64Array(days.length), cnts = new Int32Array(days.length), costs = new Float64Array(days.length), alive = new Int32Array(days.length);
    let exitsWithCost = 0;
    for (const e of evRaw) {
      if (!v.types.includes(e.event_type) || e.rcept_dt < w.from || e.rcept_dt > w.to) continue;
      counts.raw++;
      const sk = e.stock_code ? byCode.get(e.stock_code) : undefined;
      if (!sk) { counts.outNoMap++; continue; }
      const d0 = lastBefore(e.rcept_dt);
      if (!d0 || !univAt(d0).set.has(sk.code)) { counts.outUniverse++; continue; }
      const la = lastAdopted.get(e.corp_code);
      if (la !== undefined && dayDiff(la, e.rcept_dt) <= DUP_DAYS) { counts.dup++; continue; }
      const kE = firstAfter(e.rcept_dt) + extraDelay;
      if (kE < 0 || kE > lastK || kE >= CALF.length) { counts.noEntry++; continue; }
      const E = CALF[kE];
      const iE = sk.idx.get(E);
      if (iE === undefined) { counts.noEntry++; continue; }
      const prevExit = holdUntil.get(sk.code);
      if (prevExit !== undefined && prevExit > E) { counts.holding++; continue; }
      let iX = iE + v.H;
      let forced = false;
      let truncated = false;
      if (iX >= sk.dates.length) { iX = sk.dates.length - 1; forced = sk.last < endedBefore; truncated = !forced; }
      let X = sk.dates[iX];
      if (X > w.to) { truncated = true; while (iX > iE && sk.dates[iX] > w.to) iX--; X = sk.dates[iX]; }
      lastAdopted.set(e.corp_code, e.rcept_dt);
      holdUntil.set(sk.code, X);
      counts.adopted++;
      const u = univAt(d0);
      trades.push({ code: sk.code, E, X, iE, tercile: Math.floor((u.rank.get(sk.code)! * 3) / u.n) + 1, forced, truncated });
      const exitCost = !truncated;
      if (exitCost) exitsWithCost++;
      for (let i = iE + 1; i <= iX; i++) {
        const t = sk.dates[i];
        const pos = calPos.get(t);
        if (pos === undefined || pos < firstK || pos > lastK) continue;
        const di = pos - firstK;
        const prev = i === iE + 1 ? sk.close[iE] * (1 + buyRate) : sk.close[i - 1];
        const isLast = i === iX && exitCost;
        const num = isLast ? sk.close[i] * (1 - sellRateOn(t)) : sk.close[i];
        sums[di] += num / prev - 1;
        cnts[di]++;
        costs[di] += (i === iE + 1 ? buyRate : 0) + (isLast ? sellRateOn(t) : 0);
      }
      for (let k = kE + 1; k <= Math.min(calPos.get(X) ?? lastK, lastK); k++) if (k >= firstK) alive[k - firstK]++;
    }
    const ret = days.map((k, di) => (cnts[di] > 0 ? (sums[di] / cnts[di]) * 100 : d4Sim.ret[k]));
    const costFrac = days.map((_, di) => (cnts[di] > 0 ? costs[di] / cnts[di] : 0));
    return { dates: days.map((k) => CALF[k]), ret, costFrac, nAlive: Array.from(alive), trades, counts, entries: counts.adopted, exitsWithCost };
  }

  // ---- MIX ----
  function simulateMix(bb: BB, w: Win): { dates: string[]; ret: number[] } {
    const days = winDays(w);
    let vd = MIX_D4_W, vb = 1 - MIX_D4_W;
    const ret: number[] = [];
    for (let di = 0; di < days.length; di++) {
      const k = days[di];
      const prevTot = vd + vb;
      vd *= 1 + d4Sim.ret[k] / 100;
      vb *= 1 + bb.ret[di] / 100;
      let tot = vd + vb;
      if (monthEndSet.has(CALF[k]) && di < days.length - 1) {
        const moved = Math.abs(vd - MIX_D4_W * tot);
        tot -= moved * (buyRate + sellRateOn(CALF[k]));
        vd = MIX_D4_W * tot; vb = (1 - MIX_D4_W) * tot;
      }
      ret.push((tot / prevTot - 1) * 100);
    }
    return { dates: days.map((k) => CALF[k]), ret };
  }

  // ---- 지표 ----
  const endCap = (e: string): string => (e > TODAY ? TODAY : e);
  function st(dates: string[], rets: number[], w: Win) {
    const idx: number[] = [];
    for (let i = 0; i < dates.length; i++) if (dates[i] >= w.from && dates[i] <= w.to) idx.push(i);
    const r = idx.map((i) => rets[i]);
    const { totalReturnPct, mddPct } = computeCumulativeAndMdd(r);
    const cagr = computeCagrPct(totalReturnPct, w.from, endCap(w.to));
    const m = r.reduce((a, x) => a + x, 0) / Math.max(r.length, 1);
    const sd = Math.sqrt(r.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(r.length - 1, 1));
    return { cagr, mdd: mddPct, cm: mddPct > 0 ? cagr / mddPct : NaN, vol: sd * Math.sqrt(252) };
  }
  const yrsOf = (w: Win): number => Math.max(dayDiff(w.from, endCap(w.to)) / 365.25, 1e-9);
  const yearRet = (dates: string[], rets: number[], y: number, w: Win): number => computeCumulativeAndMdd(rets.filter((_, i) => dates[i].startsWith(`${y}-`) && dates[i] >= w.from && dates[i] <= w.to)).totalReturnPct;

  interface Run { v: Variant; bb: BB; mix: { dates: string[]; ret: number[] }; sBB: ReturnType<typeof st>; sMix: ReturnType<typeof st>; avgHold: number; holdShare: number; turnover: number; cost: number }
  function runVariant(v: Variant, extra: number, w: Win): Run {
    const bb = simulateBB(v, extra, w);
    const mix = simulateMix(bb, w);
    const sBB = st(bb.dates, bb.ret, w), sMix = st(mix.dates, mix.ret, w);
    const avgHold = bb.nAlive.reduce((a, x) => a + x, 0) / Math.max(bb.nAlive.length, 1);
    const hd = bb.nAlive.filter((n) => n > 0);
    const avgHeld = hd.reduce((a, x) => a + x, 0) / Math.max(hd.length, 1);
    return { v, bb, mix, sBB, sMix, avgHold, holdShare: hd.length / Math.max(bb.nAlive.length, 1), turnover: ((bb.entries + bb.exitsWithCost) / 2 / Math.max(avgHeld, 1e-9) / yrsOf(w)) * 100, cost: bb.costFrac.reduce((a, x) => a + x, 0) * 100 };
  }
  const base = (w: Win) => ({ D4: st(CALF, d4Sim.ret, w), KOSPI: st(kDates, kRets, w), EW: st(CALF, ew, w) });
  const printCounts = (label: string, runs: Run[]): void => {
    console.log(`\n(g) 이벤트 정의 적용 결과 — ${label}`);
    console.log("| 변형 | 원본 후보 이벤트 | 유니버스 밖 제외 | 그중 종목 매핑·가격 없음 | 30일 중복 제외 | 보유 중 제외 | 진입 불가 제외 | 채택 |\n|---|---|---|---|---|---|---|---|");
    for (const r of runs) { const c = r.bb.counts; console.log(`| ${r.v.name} | ${c.raw} | ${c.outUniverse + c.outNoMap} | ${c.outNoMap} | ${c.dup} | ${c.holding} | ${c.noEntry} | ${c.adopted} |`); }
  };

  // ---- 1. 학습 ----
  const learnRuns = VARIANTS.map((v) => runVariant(v, 0, LEARN));
  const bL = base(LEARN);
  const gates = learnRuns.map((r) => ({ g1: r.sBB.cagr > bL.EW.cagr, g2: r.sMix.cagr > bL.D4.cagr, g3: r.sMix.mdd <= bL.D4.mdd + G3_MARGIN, g4: r.sMix.cm > bL.D4.cm }));
  console.log("\n=== (b) 학습 구간(2015-01-01~2020-12-31) ===");
  console.log("| 구성 | CAGR % | MDD % | CAGR÷MDD | 연변동성 % |\n|---|---|---|---|---|");
  for (const r of learnRuns) { console.log(`| ${r.v.name} BB | ${f2(r.sBB.cagr)} | ${f2(r.sBB.mdd)} | ${f2(r.sBB.cm)} | ${f2(r.sBB.vol)} |`); console.log(`| ${r.v.name} MIX | ${f2(r.sMix.cagr)} | ${f2(r.sMix.mdd)} | ${f2(r.sMix.cm)} | ${f2(r.sMix.vol)} |`); }
  for (const [lab, s] of [["D4", bL.D4], ["KOSPI", bL.KOSPI], ["EW", bL.EW]] as const) console.log(`| ${lab} | ${f2(s.cagr)} | ${f2(s.mdd)} | ${f2(s.cm)} | ${f2(s.vol)} |`);
  console.log("\n| 변형 | BB 연 회전율 % | BB 누적 비용 % | 평균 동시 보유(전체 일) | 보유 1개 이상인 날 비율 % | 채택 이벤트 수 | G1 | G2 | G3 | G4 | 전부 O |\n|---|---|---|---|---|---|---|---|---|---|---|");
  learnRuns.forEach((r, i) => { const g = gates[i]; console.log(`| ${r.v.name} | ${f2(r.turnover)} | ${f2(r.cost)} | ${r.avgHold.toFixed(2)} | ${f2(r.holdShare * 100)} | ${r.bb.counts.adopted} | ${ox(g.g1)} | ${ox(g.g2)} | ${ox(g.g3)} | ${ox(g.g4)} | ${ox(g.g1 && g.g2 && g.g3 && g.g4)} |`); });
  console.log(`기준: G1 BB CAGR > EW ${f2(bL.EW.cagr)}, G2 MIX CAGR > D4 ${f2(bL.D4.cagr)}, G3 MIX MDD ≤ D4 ${f2(bL.D4.mdd)} + ${G3_MARGIN}, G4 MIX CAGR÷MDD > D4 ${f2(bL.D4.cm)}`);
  printCounts("학습", learnRuns);

  // ---- 선택 ----
  const qual = learnRuns.map((r, i) => ({ r, ok: gates[i].g1 && gates[i].g2 && gates[i].g3 && gates[i].g4 })).filter((x) => x.ok).sort((a, b) => b.r.sMix.cm - a.r.sMix.cm || a.r.turnover - b.r.turnover);
  console.log("\n=== (c) 선택 결과 ===");
  if (!qual.length) { console.log("선택 없음 (G1~G4 전부 O인 변형 0개) — 확인·홀드아웃을 계산하지 않고 종료합니다."); } else {
    const sel = qual[0].r.v;
    console.log(`전부 O인 변형 ${qual.length}개: ${qual.map((x) => `${x.r.v.name}(MIX ${f2(x.r.sMix.cm)})`).join(", ")} → 선택: ${sel.name}`);
    const stageRuns: { label: string; w: Win; learn: boolean }[] = [{ label: "학습", w: LEARN, learn: true }];
    const report = (label: string, w: Win, main: Run, dly: Run): boolean => {
      const b = base(w);
      const g = [main.sBB.cagr > b.EW.cagr, main.sMix.cagr > b.D4.cagr, main.sMix.mdd <= b.D4.mdd + G3_MARGIN, main.sMix.cm > b.D4.cm, main.sMix.cagr - dly.sMix.cagr <= G5_MAX_DROP];
      console.log(`\n=== ${label} (${w.from}~${w.to === "9999-12-31" ? "데이터 끝" : w.to}) — 변형 ${sel.name} ===`);
      console.log("| 구성 | CAGR % | MDD % | CAGR÷MDD | 연변동성 % |\n|---|---|---|---|---|");
      for (const [lab, s] of [["BB", main.sBB], ["MIX", main.sMix], ["D4", b.D4], ["KOSPI", b.KOSPI], ["EW", b.EW]] as const) console.log(`| ${lab} | ${f2(s.cagr)} | ${f2(s.mdd)} | ${f2(s.cm)} | ${f2(s.vol)} |`);
      console.log(`BB 연 회전율 ${f2(main.turnover)}% | BB 누적 비용 ${f2(main.cost)}% | 평균 동시 보유 ${main.avgHold.toFixed(2)}(보유 1개 이상인 날 ${f2(main.holdShare * 100)}%) | 채택 이벤트 ${main.bb.counts.adopted}`);
      console.log("| 기준 | 수치 | O/X |\n|---|---|---|");
      console.log(`| G1 BB CAGR > EW | ${f2(main.sBB.cagr)} vs ${f2(b.EW.cagr)} | ${ox(g[0])} |`);
      console.log(`| G2 MIX CAGR > D4 | ${f2(main.sMix.cagr)} vs ${f2(b.D4.cagr)} | ${ox(g[1])} |`);
      console.log(`| G3 MIX MDD ≤ D4 MDD + 2.0%p | ${f2(main.sMix.mdd)} vs ${f2(b.D4.mdd + G3_MARGIN)} | ${ox(g[2])} |`);
      console.log(`| G4 MIX CAGR÷MDD > D4 | ${f2(main.sMix.cm)} vs ${f2(b.D4.cm)} | ${ox(g[3])} |`);
      console.log(`| G5 진입 +1거래일 지연 시 MIX CAGR 하락 ≤ 1.0%p | 기본 ${f2(main.sMix.cagr)} → 지연 ${f2(dly.sMix.cagr)} (하락 ${f2(main.sMix.cagr - dly.sMix.cagr)}%p) | ${ox(g[4])} |`);
      console.log(`지연 변형: MIX MDD ${f2(dly.sMix.mdd)} / CAGR÷MDD ${f2(dly.sMix.cm)}, BB CAGR ${f2(dly.sBB.cagr)}`);
      const ys = new Set<number>();
      for (const d of main.mix.dates) ys.add(Number(d.slice(0, 4)));
      const years = [...ys].sort();
      console.log("\n연도별 수익률 % (구간 안)\n| 연도 | MIX | D4 | MIX − D4 | BB | EW | BB − EW |\n|---|---|---|---|---|---|---|");
      for (const y of years) {
        const m = yearRet(main.mix.dates, main.mix.ret, y, w), d = yearRet(CALF, d4Sim.ret, y, w), bbv = yearRet(main.bb.dates, main.bb.ret, y, w), e = yearRet(CALF, ew, y, w);
        console.log(`| ${y} | ${f2(m)} | ${f2(d)} | ${f2(m - d)} | ${f2(bbv)} | ${f2(e)} | ${f2(bbv - e)} |`);
      }
      printCounts(label, [main]);
      // (f) 정보용
      console.log(`\n(f) 정보용 — ${label}: 이벤트 후 k일 평균 누적 초과수익 % (종목 − EW, 비용 제외)`);
      const pick = (ks: number[], tr: Trade[]): string[] => ks.map((k) => {
        const xs: number[] = [];
        for (const t of tr) {
          const sk = byCode.get(t.code)!;
          const iK = t.iE + k;
          if (iK >= sk.dates.length) continue;
          const dk = sk.dates[iK];
          if (dk > w.to) continue;
          const pe = calPos.get(t.E), pk = calPos.get(dk);
          if (pe === undefined || pk === undefined) continue;
          const stockCum = sk.close[iK] / sk.close[t.iE] - 1;
          const ewCum = Math.exp(ewLog[pk + 1] - ewLog[pe + 1]) - 1;
          xs.push((stockCum - ewCum) * 100);
        }
        return xs.length ? `${f2(xs.reduce((a, x) => a + x, 0) / xs.length)} (n=${xs.length})` : "-";
      });
      const ks = HORIZONS.filter((k) => k <= sel.H);
      console.log("| k | " + ks.join(" | ") + " |\n|---|" + ks.map(() => "---").join("|") + "|");
      console.log("| 전체 | " + pick(ks, main.bb.trades).join(" | ") + " |");
      const k3 = [...new Set([5, 20, sel.H])].filter((k) => k <= sel.H);
      console.log("\n시총 3분위별(d0 유니버스 기준, 1=대형) 평균 누적 초과수익 %\n| 3분위 | " + k3.map((k) => `k=${k}`).join(" | ") + " | 이벤트 수 |\n|---|" + k3.map(() => "---").join("|") + "|---|");
      for (const q of [1, 2, 3]) { const tr = main.bb.trades.filter((t) => t.tercile === q); console.log(`| ${q} | ${pick(k3, tr).join(" | ")} | ${tr.length} |`); }
      return g.every(Boolean);
    };
    void stageRuns;
    const sMain = runVariant(sel, 0, LEARN);
    console.log(`\n(학습 구간 선택 변형 정보용은 아래 학습 블록)`);
    // 학습 정보용
    {
      const b = base(LEARN);
      console.log(`\n(f) 정보용 — 학습: 이벤트 후 k일 평균 누적 초과수익 % (종목 − EW, 비용 제외), 변형 ${sel.name}`);
      const ks = HORIZONS.filter((k) => k <= sel.H);
      const xsAt = (k: number, tr: Trade[]): string => {
        const xs: number[] = [];
        for (const t of tr) {
          const sk = byCode.get(t.code)!; const iK = t.iE + k;
          if (iK >= sk.dates.length || sk.dates[iK] > LEARN.to) continue;
          const pe = calPos.get(t.E), pk = calPos.get(sk.dates[iK]);
          if (pe === undefined || pk === undefined) continue;
          xs.push((sk.close[iK] / sk.close[t.iE] - 1 - (Math.exp(ewLog[pk + 1] - ewLog[pe + 1]) - 1)) * 100);
        }
        return xs.length ? `${f2(xs.reduce((a, x) => a + x, 0) / xs.length)} (n=${xs.length})` : "-";
      };
      console.log("| k | " + ks.join(" | ") + " |\n|---|" + ks.map(() => "---").join("|") + "|");
      console.log("| 전체 | " + ks.map((k) => xsAt(k, sMain.bb.trades)).join(" | ") + " |");
      const k3 = [...new Set([5, 20, sel.H])].filter((k) => k <= sel.H);
      console.log("\n시총 3분위별 평균 누적 초과수익 %\n| 3분위 | " + k3.map((k) => `k=${k}`).join(" | ") + " | 이벤트 수 |\n|---|" + k3.map(() => "---").join("|") + "|---|");
      for (const q of [1, 2, 3]) { const tr = sMain.bb.trades.filter((t) => t.tercile === q); console.log(`| ${q} | ${k3.map((k) => xsAt(k, tr)).join(" | ")} | ${tr.length} |`); }
      void b;
    }
    // ---- 2. 확인 ----
    const cMain = runVariant(sel, 0, CONFIRM), cDly = runVariant(sel, 1, CONFIRM);
    const confirmPass = report("(d) 확인", CONFIRM, cMain, cDly);
    console.log(`확인 판정: ${confirmPass ? "G1~G5 전부 O" : "통과 아님"}`);
    if (confirmPass) {
      const hMain = runVariant(sel, 0, HOLD), hDly = runVariant(sel, 1, HOLD);
      const holdPass = report("(e) 홀드아웃", HOLD, hMain, hDly);
      console.log(`홀드아웃 판정: ${holdPass ? "최종 통과(전부 O)" : "최종 통과 아님"} (누적 시도 +1)`);
    } else console.log("확인을 통과하지 못해 홀드아웃은 계산하지 않았습니다.");
  }

  console.log("\n=== (h) 실행 지표 ===");
  console.log(`Supabase 읽은 행: ${Object.entries(dbRead).map(([k, v]) => `${k} ${v}`).join(" | ")} | 합계 ${Object.values(dbRead).reduce((a, b) => a + b, 0)}`);
  console.log(`Supabase 쓴 행: 0 | 외부 요청(DART/KIS 등): 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
