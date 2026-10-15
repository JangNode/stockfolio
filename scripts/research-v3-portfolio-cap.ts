/**
 * [임시 연구 — 병합 금지, 읽기 전용] ma_cross v3 동시 보유 종목 수 제한 포트폴리오(N=3/5/7/10/20/40) 실행기.
 * 사전 등록: research/ma-v3-portfolio-cap-prereg.md(갱신판). 신호 규칙은 바꾸지 않는다. 판정·추천 없이 숫자만 출력한다.
 */
import { getIndexPriceSeries } from "@/lib/betaPriceHistoryStorage";
import { PIT_MIN_AVG_TRADING_VALUE_WON } from "@/lib/strategyBacktestSummaryConfig";
import { accumulateStockDailyReturns, computeCumulativeAndMdd, computeCagrPct, type DailyStockReturns } from "@/lib/strategyBacktestSummary";
import { computeIndexDailyReturnsPct, simulateUniverseMonthlyRebalance, computeMonthlyRebalanceDates } from "@/lib/benchmarkSummary";
import type { StockDailyPriceRow } from "@/lib/stockDailyPricesStorage";
import {
  buildCtx, genTrades, loadSeries, PERIOD_START, LEARN_END, CONFIRM_START, TODAY, CAP_EOK, type Ctx,
} from "./research-ma-lab";

const NEAR_HIGH_MIN_GAP = -0.1829;
const NEAR_HIGH_BARS = 252;
export const CAPS = [3, 5, 7, 10, 20, 40];
export const SEEDS = 20;
const EXPECT = { cagr: "6.36", mdd: "53.31", trades: 2335 }; // 사전 등록 재현 기준(상한 없는 v3)
const PRIOR_ATTEMPTS = 43;

interface TR { buyDate: string; sellDate: string; ret: number; days: { d: string; r: number }[] }
interface PricePoint { tradeDate: string; closePrice: number }

function nearHighOk(ctx: Ctx, e: number): boolean {
  let hi = -Infinity;
  for (let j = Math.max(0, e - (NEAR_HIGH_BARS - 1)); j <= e; j++) if (ctx.prices[j].high > hi) hi = ctx.prices[j].high;
  return ctx.prices[e].close / hi - 1 > NEAR_HIGH_MIN_GAP;
}

function mulberry32(a: number): () => number {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Book { sum: Map<string, number>; cnt: Map<string, number>; trades: TR[] }
const newBook = (): Book => ({ sum: new Map(), cnt: new Map(), trades: [] });
function addTrade(b: Book, t: TR): void {
  b.trades.push(t);
  for (const { d, r } of t.days) { b.sum.set(d, (b.sum.get(d) ?? 0) + r); b.cnt.set(d, (b.cnt.get(d) ?? 0) + 1); }
}

let CAL: string[] = [];
const inRange = (s: string, e: string): string[] => CAL.filter((d) => d >= s && d <= e);

interface M { cagr: number; mdd: number; win: number; payoff: number; trades: number; hold: number }
/** denom = N(상한) 또는 null(제한 없음: 그날 보유 종목 수로 평균). */
function metrics(b: Book, start: string, end: string, denom: number | null): M {
  const days = inRange(start, end);
  const daily = days.map((d) => {
    const s = b.sum.get(d) ?? 0, c = b.cnt.get(d) ?? 0;
    return c === 0 ? 0 : (s / (denom ?? c)) * 100;
  });
  const { totalReturnPct, mddPct } = computeCumulativeAndMdd(daily);
  const t = b.trades.filter((x) => x.buyDate >= start && x.buyDate <= end);
  const wins = t.filter((x) => x.ret > 0), losses = t.filter((x) => x.ret <= 0);
  const aw = wins.reduce((s, x) => s + x.ret, 0) / Math.max(wins.length, 1);
  const al = losses.reduce((s, x) => s + x.ret, 0) / Math.max(losses.length, 1);
  const hold = days.reduce((a, d) => a + (b.cnt.get(d) ?? 0), 0) / Math.max(days.length, 1);
  return {
    cagr: computeCagrPct(totalReturnPct, start, end > TODAY ? TODAY : end), mdd: mddPct,
    win: t.length ? (wins.length / t.length) * 100 : 0, payoff: al !== 0 ? aw / Math.abs(al) : 0, trades: t.length, hold,
  };
}
function yearRet(b: Book, y: number, denom: number | null): number {
  const days = inRange(`${y}-01-01`, `${y}-12-31`);
  const daily = days.map((d) => { const s = b.sum.get(d) ?? 0, c = b.cnt.get(d) ?? 0; return c === 0 ? 0 : (s / (denom ?? c)) * 100; });
  return computeCumulativeAndMdd(daily).totalReturnPct;
}
function seriesMetrics(dates: string[], retsPct: number[], start: string, end: string): { cagr: number; mdd: number } {
  const r = retsPct.filter((_, i) => dates[i] >= start && dates[i] <= end);
  const { totalReturnPct, mddPct } = computeCumulativeAndMdd(r);
  return { cagr: computeCagrPct(totalReturnPct, start, end > TODAY ? TODAY : end), mdd: mddPct };
}
function seriesYear(dates: string[], retsPct: number[], y: number): number {
  return computeCumulativeAndMdd(retsPct.filter((_, i) => dates[i].startsWith(`${y}-`))).totalReturnPct;
}

function simulateCap(all: TR[], n: number, seed: number): { book: Book; admitted: boolean[] } {
  const idxByBuy = new Map<string, number[]>();
  all.forEach((t, i) => { const l = idxByBuy.get(t.buyDate); if (l) l.push(i); else idxByBuy.set(t.buyDate, [i]); });
  const rng = mulberry32(seed);
  const book = newBook();
  const admitted = new Array<boolean>(all.length).fill(false);
  let open: string[] = [];
  for (const d of [...idxByBuy.keys()].sort()) {
    open = open.filter((s) => s > d); // 청산일 종가에 슬롯이 비면 같은 날 진입 가능
    const free = n - open.length;
    if (free <= 0) continue;
    const c = idxByBuy.get(d)!.slice();
    if (c.length > free) for (let i = c.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [c[i], c[j]] = [c[j], c[i]]; }
    for (const i of c.slice(0, free)) { open.push(all[i].sellDate); addTrade(book, all[i]); admitted[i] = true; }
  }
  return { book, admitted };
}

const f2 = (x: number): string => x.toFixed(2);
const mean = (v: number[]): number => v.reduce((a, x) => a + x, 0) / v.length;
const std = (v: number[]): number => { if (v.length < 2) return 0; const m = mean(v); return Math.sqrt(v.reduce((a, x) => a + (x - m) ** 2, 0) / (v.length - 1)); };
const median = (v: number[]): number => { if (!v.length) return NaN; const s = [...v].sort((a, b) => a - b); const h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
const dist = (v: number[]): string => `평균 ${f2(mean(v))} / 최소 ${f2(Math.min(...v))} / 최대 ${f2(Math.max(...v))} / 표준편차 ${f2(std(v))}`;

const SLICES: [string, string, string][] = [["전체 2010~", PERIOD_START, TODAY], ["학습 2010~2018", PERIOD_START, LEARN_END], ["확인 2019~", CONFIRM_START, TODAY]];

export interface StudyInput { series: Map<string, StockDailyPriceRow[]>; kospi: PricePoint[]; reproGate: boolean }

export async function runStudy(inp: StudyInput): Promise<{ ok: boolean }> {
  const { series, kospi } = inp;
  const cal = new Set<string>();
  for (const rows of series.values()) for (const r of rows) if (r.tradeDate >= PERIOD_START) cal.add(r.tradeDate);
  CAL = [...cal].sort();
  const rebalanceDates = computeMonthlyRebalanceDates(CAL);
  console.log(`거래일 캘린더 ${CAL.length}일 ${CAL[0]}~${CAL[CAL.length - 1]}`);

  const all: TR[] = [];
  const pricesByStock = new Map<string, { date: string; close: number }[]>();
  const liquidity = new Map<string, Map<string, number>>();
  for (const [code, rows] of series) {
    const ctx = buildCtx(code, rows);
    series.delete(code);
    pricesByStock.set(code, ctx.prices.map((p) => ({ date: p.date, close: p.close })));
    const idx = new Map(ctx.prices.map((p, i) => [p.date, i]));
    const lq = new Map<string, number>();
    for (const d of rebalanceDates) {
      const i = idx.get(d);
      if (i !== undefined && Number.isFinite(ctx.avgTv[i]) && rows[i].marketCapEok >= CAP_EOK) lq.set(d, ctx.avgTv[i]);
    }
    liquidity.set(code, lq);
    if (ctx.goldens.length === 0) continue;
    for (const t of genTrades(ctx, { name: "v3", entryFilter: (c, e) => nearHighOk(c, e) })) {
      const tmp: DailyStockReturns = new Map();
      accumulateStockDailyReturns(tmp, new Map(), code, ctx.prices, [t], PERIOD_START, "KR", true);
      all.push({ buyDate: t.buyDate, sellDate: t.sellDate, ret: t.returnPct, days: [...tmp.entries()].map(([d, es]) => ({ d, r: es[0].returnPct })) });
    }
  }
  all.sort((a, b) => (a.buyDate === b.buyDate ? a.sellDate.localeCompare(b.sellDate) : a.buyDate.localeCompare(b.buyDate)));

  // ---- 1) 재현 확인 (상한 없는 v3) ----
  const base = newBook();
  for (const t of all) addTrade(base, t);
  const b0 = metrics(base, PERIOD_START, TODAY, null);
  console.log(`\n=== 1) 상한 없는 v3 재현 확인 ===`);
  console.log(`하네스: CAGR ${f2(b0.cagr)}% | MDD ${f2(b0.mdd)}% | 거래 ${b0.trades}건 | 승률 ${b0.win.toFixed(1)}% | 손익비 ${f2(b0.payoff)}`);
  console.log(`사전 등록 기준: CAGR ${EXPECT.cagr}% | MDD ${EXPECT.mdd}% | 거래 ${EXPECT.trades}건`);
  const match = f2(b0.cagr) === EXPECT.cagr && f2(b0.mdd) === EXPECT.mdd && b0.trades === EXPECT.trades;
  console.log(`재현 결과: ${match ? "일치" : "불일치"}`);
  if (inp.reproGate && !match) {
    console.log("재현이 어긋나 N별 실행을 하지 않고 중단합니다. (원인 후보: 데이터 범위(연도 파일)·조정계수 적용 차이, 집계 구현 차이)");
    return { ok: false };
  }

  // ---- 비교 대상 ----
  const kDates = kospi.slice(1).map((p) => p.tradeDate);
  const kRets = computeIndexDailyReturnsPct(kospi as never);
  const uRets = simulateUniverseMonthlyRebalance(
    pricesByStock, CAL, PERIOD_START,
    (code, date) => (liquidity.get(code)?.get(date) ?? NaN) >= PIT_MIN_AVG_TRADING_VALUE_WON, true
  );
  const uDates = CAL.filter((d) => d >= PERIOD_START);
  const years: number[] = [];
  for (let y = 2010; y <= Number(TODAY.slice(0, 4)); y++) years.push(y);

  // ---- 2) N별 시드 실행 ----
  const perN = new Map<number, { book: Book; admitted: boolean[] }[]>();
  for (const n of CAPS) perN.set(n, Array.from({ length: SEEDS }, (_, i) => simulateCap(all, n, i + 1)));

  console.log(`\n=== 2) 요약표 (시드 ${SEEDS}개 평균; 확인 구간은 N당 1회 계산) ===`);
  for (const [lab, s, e] of SLICES) {
    console.log(`\n[${lab}]`);
    console.log("| 구성 | CAGR % | MDD % | 승률 % | 손익비 | 거래 수 | 평균 동시 보유 |");
    console.log("|---|---|---|---|---|---|---|");
    const m = metrics(base, s, e, null);
    console.log(`| 상한 없는 v3 | ${f2(m.cagr)} | ${f2(m.mdd)} | ${m.win.toFixed(1)} | ${f2(m.payoff)} | ${m.trades} | ${m.hold.toFixed(1)} |`);
    for (const n of CAPS) {
      const ms = perN.get(n)!.map((r) => metrics(r.book, s, e, n));
      console.log(`| N=${n} | ${f2(mean(ms.map((x) => x.cagr)))} | ${f2(mean(ms.map((x) => x.mdd)))} | ${mean(ms.map((x) => x.win)).toFixed(1)} | ${f2(mean(ms.map((x) => x.payoff)))} | ${mean(ms.map((x) => x.trades)).toFixed(0)} | ${mean(ms.map((x) => x.hold)).toFixed(1)} |`);
    }
    const k = seriesMetrics(kDates, kRets, s, e), u = seriesMetrics(uDates, uRets, s, e);
    console.log(`| KOSPI(가격지수) | ${f2(k.cagr)} | ${f2(k.mdd)} | - | - | - | - |`);
    console.log(`| 유니버스 동일가중 월리밸 | ${f2(u.cagr)} | ${f2(u.mdd)} | - | - | - | - |`);
  }

  console.log(`\n=== 3) 시드 간 분포 (평균 / 최소 / 최대 / 표준편차) ===`);
  for (const n of CAPS) {
    for (const [lab, s, e] of SLICES) {
      const ms = perN.get(n)!.map((r) => metrics(r.book, s, e, n));
      console.log(`N=${n} ${lab}:`);
      console.log(`  CAGR % ${dist(ms.map((x) => x.cagr))}`);
      console.log(`  MDD % ${dist(ms.map((x) => x.mdd))}`);
      console.log(`  승률 % ${dist(ms.map((x) => x.win))}`);
      console.log(`  손익비 ${dist(ms.map((x) => x.payoff))}`);
      console.log(`  거래 수 ${dist(ms.map((x) => x.trades))}`);
      console.log(`  평균 동시 보유 ${dist(ms.map((x) => x.hold))}`);
    }
  }

  console.log(`\n=== 4) 상한 때문에 놓친 신호 (신호 규칙 불변, 가정 수익률은 상한 없는 v3 방식 보유 기준) ===`);
  for (const n of CAPS) {
    const runs = perN.get(n)!;
    for (const [lab, s, e] of SLICES) {
      const inSlice = all.map((t, i) => (t.buyDate >= s && t.buyDate <= e ? i : -1)).filter((i) => i >= 0);
      const per = runs.map((r) => {
        const missed = inSlice.filter((i) => !r.admitted[i]).map((i) => all[i].ret);
        const adm = inSlice.filter((i) => r.admitted[i]).map((i) => all[i].ret);
        const pct = (v: number[]): number => (v.length ? (v.filter((x) => x > 0).length / v.length) * 100 : NaN);
        const avg = (v: number[]): number => (v.length ? mean(v) * 100 : NaN);
        return { missed: missed.length, share: (missed.length / Math.max(inSlice.length, 1)) * 100, mWin: pct(missed), aWin: pct(adm), mMean: avg(missed), aMean: avg(adm), mMed: median(missed) * 100, aMed: median(adm) * 100 };
      });
      const ok = (v: number[]): number[] => v.filter(Number.isFinite);
      console.log(
        `N=${n} ${lab}: 전체 신호 ${inSlice.length}건 | 놓친 신호 ${dist(per.map((p) => p.missed))} (${f2(mean(per.map((p) => p.share)))}%) | ` +
          `놓친 거래 이후 수익>0 비율 ${f2(mean(ok(per.map((p) => p.mWin))))}% vs 채택 거래 ${f2(mean(ok(per.map((p) => p.aWin))))}% | ` +
          `거래 수익률 평균 놓친 ${f2(mean(ok(per.map((p) => p.mMean))))}% / 채택 ${f2(mean(ok(per.map((p) => p.aMean))))}% | ` +
          `중앙값 놓친 ${f2(mean(ok(per.map((p) => p.mMed))))}% / 채택 ${f2(mean(ok(per.map((p) => p.aMed))))}%`
      );
    }
  }

  console.log(`\n=== 5) 연도별 수익률 % (시드 평균) ===`);
  console.log(`상한 없는 v3: ${years.map((y) => `${y}: ${f2(yearRet(base, y, null))}`).join(", ")}`);
  for (const n of CAPS) console.log(`N=${n}: ${years.map((y) => `${y}: ${f2(mean(perN.get(n)!.map((r) => yearRet(r.book, y, n))))}`).join(", ")}`);
  console.log(`KOSPI: ${years.map((y) => `${y}: ${f2(seriesYear(kDates, kRets, y))}`).join(", ")}`);
  console.log(`유니버스 동일가중: ${years.map((y) => `${y}: ${f2(seriesYear(uDates, uRets, y))}`).join(", ")}`);

  console.log(`\n누적 시도 횟수: ${PRIOR_ATTEMPTS} + ${CAPS.length} = ${PRIOR_ATTEMPTS + CAPS.length}회 (N 값 하나당 1회)`);
  console.log("완료");
  return { ok: true };
}

async function main(): Promise<void> {
  console.log(`ma_cross v3 동시 보유 제한 포트폴리오 시작(in-sample): ${new Date().toISOString()}`);
  const series = await loadSeries();
  const kospi = await getIndexPriceSeries("KOSPI", PERIOD_START, TODAY);
  const { ok } = await runStudy({ series, kospi, reproGate: true });
  if (!ok) process.exit(2);
}
if (process.argv[1] && process.argv[1].endsWith("research-v3-portfolio-cap.ts")) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
