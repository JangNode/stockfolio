/**
 * [임시 연구 — 병합 금지, 읽기 전용] ma_cross v3 동시 보유 종목 수 제한 포트폴리오(N=10/20/40) 실행기.
 * 사전 등록: research/ma-v3-portfolio-cap-prereg.md (커밋 53b73c9). 신호 규칙은 바꾸지 않는다.
 */
import { getIndexPriceSeries } from "@/lib/betaPriceHistoryStorage";
import { PIT_MIN_AVG_TRADING_VALUE_WON } from "@/lib/strategyBacktestSummaryConfig";
import { accumulateStockDailyReturns, computeCumulativeAndMdd, computeCagrPct, type DailyStockReturns } from "@/lib/strategyBacktestSummary";
import { computeIndexDailyReturnsPct, simulateUniverseMonthlyRebalance, computeMonthlyRebalanceDates } from "@/lib/benchmarkSummary";
import {
  buildCtx, genTrades, loadSeries, PERIOD_START, LEARN_END, CONFIRM_START, TODAY, CAP_EOK, type Ctx,
} from "./research-ma-lab";

const NEAR_HIGH_MIN_GAP = -0.1829;
const NEAR_HIGH_BARS = 252;
const CAPS = [10, 20, 40];
const SEEDS = 20;

interface TR { buyDate: string; sellDate: string; ret: number; days: { d: string; r: number }[] }

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

interface M { cagr: number; mdd: number; win: number; trades: number; hold: number; cash: number }
/** denom = N(상한) 또는 null(제한 없음: 그날 보유 종목 수로 평균). */
function metrics(b: Book, start: string, end: string, denom: number | null): M {
  const days = inRange(start, end);
  const daily = days.map((d) => {
    const s = b.sum.get(d) ?? 0, c = b.cnt.get(d) ?? 0;
    if (c === 0) return 0;
    return (s / (denom ?? c)) * 100;
  });
  const { totalReturnPct, mddPct } = computeCumulativeAndMdd(daily);
  const endCap = end > TODAY ? TODAY : end;
  const t = b.trades.filter((x) => x.buyDate >= start && x.buyDate <= end);
  const hold = days.reduce((a, d) => a + (b.cnt.get(d) ?? 0), 0) / Math.max(days.length, 1);
  const cash = days.reduce((a, d) => { const c = b.cnt.get(d) ?? 0; return a + (denom === null ? (c === 0 ? 1 : 0) : 1 - c / denom); }, 0) / Math.max(days.length, 1);
  return { cagr: computeCagrPct(totalReturnPct, start, endCap), mdd: mddPct, win: t.length ? (t.filter((x) => x.ret > 0).length / t.length) * 100 : 0, trades: t.length, hold, cash: cash * 100 };
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

function simulateCap(all: TR[], n: number, seed: number): Book {
  const byBuy = new Map<string, TR[]>();
  for (const t of all) { const l = byBuy.get(t.buyDate); if (l) l.push(t); else byBuy.set(t.buyDate, [t]); }
  const rng = mulberry32(seed);
  const b = newBook();
  let open: string[] = [];
  for (const d of [...byBuy.keys()].sort()) {
    open = open.filter((s) => s > d); // 청산일 종가에 슬롯이 비면 같은 날 진입 가능
    const free = n - open.length;
    if (free <= 0) continue;
    const c = byBuy.get(d)!.slice();
    if (c.length > free) for (let i = c.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [c[i], c[j]] = [c[j], c[i]]; }
    for (const t of c.slice(0, free)) { open.push(t.sellDate); addTrade(b, t); }
  }
  return b;
}

const f1 = (x: number): string => x.toFixed(2);
const stat = (v: number[]): string => `${f1(v.reduce((a, x) => a + x, 0) / v.length)} [${f1(Math.min(...v))}, ${f1(Math.max(...v))}]`;

async function main(): Promise<void> {
  console.log(`ma_cross v3 동시 보유 제한 포트폴리오 시작(in-sample): ${new Date().toISOString()}`);
  const series = await loadSeries();
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
    const trades = genTrades(ctx, { name: "v3", entryFilter: (c, e) => nearHighOk(c, e) });
    for (const t of trades) {
      const tmp: DailyStockReturns = new Map();
      accumulateStockDailyReturns(tmp, new Map(), code, ctx.prices, [t], PERIOD_START, "KR", true);
      const days = [...tmp.entries()].map(([d, es]) => ({ d, r: es[0].returnPct }));
      all.push({ buyDate: t.buyDate, sellDate: t.sellDate, ret: t.returnPct, days });
    }
  }
  console.log(`v3 신호(제한 없음) 거래 ${all.length}건`);

  // ---- 비교 대상 ----
  const base = newBook();
  for (const t of all) addTrade(base, t);
  const kospi = await getIndexPriceSeries("KOSPI", PERIOD_START, TODAY);
  const kDates = kospi.slice(1).map((p) => p.tradeDate);
  const kRets = computeIndexDailyReturnsPct(kospi);
  const uRets = simulateUniverseMonthlyRebalance(
    pricesByStock, CAL, PERIOD_START,
    (code, date) => (liquidity.get(code)?.get(date) ?? NaN) >= PIT_MIN_AVG_TRADING_VALUE_WON, true
  );
  const uDates = CAL.filter((d) => d >= PERIOD_START);

  const slices: [string, string, string][] = [["전체 2010~", PERIOD_START, TODAY], ["학습 2010~2018", PERIOD_START, LEARN_END], ["확인 2019~", CONFIRM_START, TODAY]];
  const years: number[] = [];
  for (let y = 2010; y <= Number(TODAY.slice(0, 4)); y++) years.push(y);

  console.log(`\n=== 비교 대상 ===`);
  for (const [lab, s, e] of slices) {
    const m = metrics(base, s, e, null), k = seriesMetrics(kDates, kRets, s, e), u = seriesMetrics(uDates, uRets, s, e);
    console.log(`[${lab}] v3 제한없음: CAGR ${f1(m.cagr)} | MDD ${f1(m.mdd)} | 승률 ${m.win.toFixed(1)} | 거래 ${m.trades} | 평균보유 ${m.hold.toFixed(1)} | 평균현금 ${m.cash.toFixed(1)}%  ||  KOSPI CAGR ${f1(k.cagr)} MDD ${f1(k.mdd)}  ||  유니버스 동일가중 월리밸 CAGR ${f1(u.cagr)} MDD ${f1(u.mdd)}`);
  }
  console.log(`(검증: 사용자 지정 v3 전체 6.36/53.31/32.2%/2,335, KOSPI 8.46, 유니버스 3.64)`);
  console.log(`연도별 v3: ${years.map((y) => `${y}: ${f1(yearRet(base, y, null))}`).join(", ")}`);
  console.log(`연도별 KOSPI: ${years.map((y) => `${y}: ${f1(seriesYear(kDates, kRets, y))}`).join(", ")}`);
  console.log(`연도별 유니버스 동일가중: ${years.map((y) => `${y}: ${f1(seriesYear(uDates, uRets, y))}`).join(", ")}`);

  // ---- 상한 포트폴리오 ----
  for (const n of CAPS) {
    const books = Array.from({ length: SEEDS }, (_, i) => simulateCap(all, n, i + 1));
    console.log(`\n=== N=${n} (시드 1~${SEEDS}, 평균 [최소, 최대]) ===`);
    for (const [lab, s, e] of slices) {
      const ms = books.map((b) => metrics(b, s, e, n));
      console.log(`[${lab}] CAGR ${stat(ms.map((m) => m.cagr))} | MDD ${stat(ms.map((m) => m.mdd))} | 승률 ${stat(ms.map((m) => m.win))} | 거래 ${stat(ms.map((m) => m.trades))} | 평균보유 ${stat(ms.map((m) => m.hold))} | 평균현금 ${stat(ms.map((m) => m.cash))}%`);
    }
    console.log(`연도별(평균 [최소, 최대]): ${years.map((y) => `${y}: ${stat(books.map((b) => yearRet(b, y, n)))}`).join(" | ")}`);
    const full = books.map((b) => metrics(b, PERIOD_START, TODAY, n));
    const lrn = books.map((b) => metrics(b, PERIOD_START, LEARN_END, n));
    const cnf = books.map((b) => metrics(b, CONFIRM_START, TODAY, n));
    console.log(`시드별 CAGR/MDD (전체 | 학습 | 확인):`);
    full.forEach((m, i) => console.log(`  seed ${i + 1}: ${f1(m.cagr)}/${f1(m.mdd)} | ${f1(lrn[i].cagr)}/${f1(lrn[i].mdd)} | ${f1(cnf[i].cagr)}/${f1(cnf[i].mdd)}`));
  }
  console.log("완료");
}
main().catch((e) => { console.error(e); process.exit(1); });
