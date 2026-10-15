/**
 * [임시 연구 — 병합 금지, 읽기 전용] ma_cross v3 동시 보유 상한 포트폴리오 — 순위 규칙(52주 고가 근접도, N=10/20) 실행기.
 * 사전 등록: research/ma-v3-portfolio-cap-prereg.md 9항(추가). 신호 규칙은 바꾸지 않는다. 판정·추천 없이 숫자만 출력한다.
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
export const CAPS = [10, 20];
export const SEEDS = 20;
const EXPECT = { cagr: "6.36", mdd: "53.31", trades: 2335 }; // 사전 등록 재현 기준(상한 없는 v3)
const PRIOR_ATTEMPTS = 49;
const PASS = { cagr: 6.36, mdd: 53.31 }; // 사전 통과 기준(전체 구간)
const PRIOR_RANDOM: Record<number, string> = { 10: "0.16 / 63.76", 20: "3.45 / 62.25" }; // 사용자 지정 이전 무작위 결과(전체, 시드 평균)

interface TR { code: string; rank: number; buyDate: string; sellDate: string; ret: number; days: { d: string; r: number }[] }
interface PricePoint { tradeDate: string; closePrice: number }

function nearHighOk(ctx: Ctx, e: number): boolean {
  let hi = -Infinity;
  for (let j = Math.max(0, e - (NEAR_HIGH_BARS - 1)); j <= e; j++) if (ctx.prices[j].high > hi) hi = ctx.prices[j].high;
  return ctx.prices[e].close / hi - 1 > NEAR_HIGH_MIN_GAP;
}

/** 신호일 종가 ÷ 최근 252봉 최고가(고가 기준, 신호봉 포함). */
function nearHighRatio(ctx: Ctx, e: number): number {
  let hi = -Infinity;
  for (let j = Math.max(0, e - (NEAR_HIGH_BARS - 1)); j <= e; j++) if (ctx.prices[j].high > hi) hi = ctx.prices[j].high;
  return ctx.prices[e].close / hi;
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

function simulateCap(all: TR[], n: number, seed: number, order: "random" | "rank"): { book: Book; admitted: boolean[] } {
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
    if (c.length > free) {
      if (order === "rank") c.sort((a, b) => (all[b].rank - all[a].rank) || (all[a].code < all[b].code ? -1 : all[a].code > all[b].code ? 1 : 0));
      else for (let i = c.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [c[i], c[j]] = [c[j], c[i]]; }
    }
    for (const i of c.slice(0, free)) { open.push(all[i].sellDate); addTrade(book, all[i]); admitted[i] = true; }
  }
  return { book, admitted };
}

const f2 = (x: number): string => x.toFixed(2);
const mean = (v: number[]): number => v.reduce((a, x) => a + x, 0) / v.length;
const std = (v: number[]): number => { if (v.length < 2) return 0; const m = mean(v); return Math.sqrt(v.reduce((a, x) => a + (x - m) ** 2, 0) / (v.length - 1)); };
const median = (v: number[]): number => { if (!v.length) return NaN; const s = [...v].sort((a, b) => a - b); const h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };

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
      all.push({ code, rank: nearHighRatio(ctx, t.eIdx), buyDate: t.buyDate, sellDate: t.sellDate, ret: t.returnPct, days: [...tmp.entries()].map(([d, es]) => ({ d, r: es[0].returnPct })) });
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

  // ---- 2) 순위 규칙(결정적) + 무작위(이전 실행 재계산, 비교용) ----
  const rankRuns = new Map<number, { book: Book; admitted: boolean[] }>();
  const randRuns = new Map<number, { book: Book; admitted: boolean[] }[]>();
  for (const n of CAPS) {
    rankRuns.set(n, simulateCap(all, n, 0, "rank"));
    randRuns.set(n, Array.from({ length: SEEDS }, (_, i) => simulateCap(all, n, i + 1, "random")));
  }
  console.log(`\n=== 2) 이전 무작위 결과 재계산 확인 (전체 구간 CAGR / MDD, 시드 평균) ===`);
  for (const n of CAPS) {
    const ms = randRuns.get(n)!.map((r) => metrics(r.book, PERIOD_START, TODAY, n));
    const got = `${f2(mean(ms.map((x) => x.cagr)))} / ${f2(mean(ms.map((x) => x.mdd)))}`;
    console.log(`N=${n}: 재계산 ${got} | 사용자 지정 ${PRIOR_RANDOM[n]} | ${got === PRIOR_RANDOM[n] ? "일치" : "불일치"}`);
  }

  console.log(`\n=== 3) 요약표 (순위 규칙은 결정적 1회 실행; 무작위는 시드 ${SEEDS}개 평균) ===`);
  for (const [lab, s0, e0] of SLICES) {
    console.log(`\n[${lab}]`);
    console.log("| 구성 | CAGR % | MDD % | 승률 % | 손익비 | 거래 수 | 평균 동시 보유 |");
    console.log("|---|---|---|---|---|---|---|");
    const m = metrics(base, s0, e0, null);
    console.log(`| 상한 없는 v3 | ${f2(m.cagr)} | ${f2(m.mdd)} | ${m.win.toFixed(1)} | ${f2(m.payoff)} | ${m.trades} | ${m.hold.toFixed(1)} |`);
    for (const n of CAPS) {
      const r = metrics(rankRuns.get(n)!.book, s0, e0, n);
      console.log(`| N=${n} 순위(52주 고가 근접도) | ${f2(r.cagr)} | ${f2(r.mdd)} | ${r.win.toFixed(1)} | ${f2(r.payoff)} | ${r.trades} | ${r.hold.toFixed(1)} |`);
      const ms = randRuns.get(n)!.map((x) => metrics(x.book, s0, e0, n));
      console.log(`| N=${n} 무작위(시드 평균, 이전) | ${f2(mean(ms.map((x) => x.cagr)))} | ${f2(mean(ms.map((x) => x.mdd)))} | ${mean(ms.map((x) => x.win)).toFixed(1)} | ${f2(mean(ms.map((x) => x.payoff)))} | ${mean(ms.map((x) => x.trades)).toFixed(0)} | ${mean(ms.map((x) => x.hold)).toFixed(1)} |`);
    }
    const k = seriesMetrics(kDates, kRets, s0, e0), u = seriesMetrics(uDates, uRets, s0, e0);
    console.log(`| KOSPI(가격지수) | ${f2(k.cagr)} | ${f2(k.mdd)} | - | - | - | - |`);
    console.log(`| 유니버스 동일가중 월리밸 | ${f2(u.cagr)} | ${f2(u.mdd)} | - | - | - | - |`);
  }

  console.log(`\n=== 4) 사전 통과 기준 (전체 구간 CAGR >= ${PASS.cagr}% 그리고 MDD <= ${PASS.mdd}%) ===`);
  console.log("| 구성 | CAGR % | CAGR 기준 | MDD % | MDD 기준 | 둘 다 |");
  console.log("|---|---|---|---|---|---|");
  for (const n of CAPS) {
    const r = metrics(rankRuns.get(n)!.book, PERIOD_START, TODAY, n);
    const c = r.cagr >= PASS.cagr, d = r.mdd <= PASS.mdd;
    console.log(`| N=${n} 순위 | ${f2(r.cagr)} | ${c ? "O" : "X"} | ${f2(r.mdd)} | ${d ? "O" : "X"} | ${c && d ? "O" : "X"} |`);
  }

  console.log(`\n=== 5) 채택 거래 vs 놓친 거래 (순위 규칙; 놓친 거래는 상한 없는 v3 방식 보유 기준의 가정 수익률) ===`);
  for (const n of CAPS) {
    const run = rankRuns.get(n)!;
    for (const [lab, s0, e0] of SLICES) {
      const inSlice = all.map((t, i) => (t.buyDate >= s0 && t.buyDate <= e0 ? i : -1)).filter((i) => i >= 0);
      const missed = inSlice.filter((i) => !run.admitted[i]).map((i) => all[i].ret);
      const adm = inSlice.filter((i) => run.admitted[i]).map((i) => all[i].ret);
      const pct = (v: number[]): string => (v.length ? f2((v.filter((x) => x > 0).length / v.length) * 100) : "-");
      const avg = (v: number[]): string => (v.length ? f2(mean(v) * 100) : "-");
      const med = (v: number[]): string => (v.length ? f2(median(v) * 100) : "-");
      console.log(`N=${n} ${lab}: 전체 신호 ${inSlice.length}건 | 채택 ${adm.length}건 / 놓친 ${missed.length}건(${f2((missed.length / Math.max(inSlice.length, 1)) * 100)}%) | 이후 수익>0 비율 채택 ${pct(adm)}% / 놓친 ${pct(missed)}% | 평균 수익률 채택 ${avg(adm)}% / 놓친 ${avg(missed)}% | 중앙값 채택 ${med(adm)}% / 놓친 ${med(missed)}%`);
    }
  }

  console.log(`\n=== 6) 연도별 수익률 % ===`);
  const yl = (f: (y: number) => number): string => years.map((y) => `${y}: ${f2(f(y))}`).join(", ");
  console.log(`상한 없는 v3: ${yl((y) => yearRet(base, y, null))}`);
  for (const n of CAPS) {
    console.log(`N=${n} 순위: ${yl((y) => yearRet(rankRuns.get(n)!.book, y, n))}`);
    console.log(`N=${n} 무작위(시드 평균): ${yl((y) => mean(randRuns.get(n)!.map((r) => yearRet(r.book, y, n))))}`);
  }
  console.log(`KOSPI: ${yl((y) => seriesYear(kDates, kRets, y))}`);
  console.log(`유니버스 동일가중: ${yl((y) => seriesYear(uDates, uRets, y))}`);
  console.log(`핵심 연도 2018/2020/2022:`);
  for (const y of [2018, 2020, 2022]) {
    console.log(`  ${y}: v3 ${f2(yearRet(base, y, null))} | N=10 순위 ${f2(yearRet(rankRuns.get(10)!.book, y, 10))} | N=10 무작위 ${f2(mean(randRuns.get(10)!.map((r) => yearRet(r.book, y, 10))))} | N=20 순위 ${f2(yearRet(rankRuns.get(20)!.book, y, 20))} | N=20 무작위 ${f2(mean(randRuns.get(20)!.map((r) => yearRet(r.book, y, 20))))} | KOSPI ${f2(seriesYear(kDates, kRets, y))} | 유니버스 ${f2(seriesYear(uDates, uRets, y))}`);
  }

  console.log(`\n누적 시도 횟수: ${PRIOR_ATTEMPTS} + ${CAPS.length} = ${PRIOR_ATTEMPTS + CAPS.length}회`);
  console.log("완료");
  return { ok: true };
}

async function main(): Promise<void> {
  console.log(`ma_cross v3 순위 규칙 상한 포트폴리오 시작(in-sample): ${new Date().toISOString()}`);
  const series = await loadSeries();
  const kospi = await getIndexPriceSeries("KOSPI", PERIOD_START, TODAY);
  const { ok } = await runStudy({ series, kospi, reproGate: true });
  if (!ok) process.exit(2);
}
if (process.argv[1] && process.argv[1].endsWith("research-v3-portfolio-rank.ts")) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
