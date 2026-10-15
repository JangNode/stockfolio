/**
 * [임시 감사 — 병합 금지, 읽기 전용] v3 재검증 감사(V1 체결 지연, V2 민감도, V3 집중도, V4 부트스트랩, V5 노출 보정).
 * 사전 등록: research/audit-v3-prereg.md. 규칙 변경 없음, 판정·추천 없이 숫자와 O/X만 출력한다.
 */
import { getIndexPriceSeries } from "@/lib/betaPriceHistoryStorage";
import { PIT_MIN_AVG_TRADING_VALUE_WON } from "@/lib/strategyBacktestSummaryConfig";
import { accumulateStockDailyReturns, computeCumulativeAndMdd, computeCagrPct, type DailyStockReturns } from "@/lib/strategyBacktestSummary";
import { simulateUniverseMonthlyRebalance, computeMonthlyRebalanceDates } from "@/lib/benchmarkSummary";
import { computeEffectiveBuyPrice, computeEffectiveSellPrice, computeCostAdjustedReturnPct } from "@/lib/transactionCost";
import { computeSMA } from "@/lib/sma";
import type { StockDailyPriceRow } from "@/lib/stockDailyPricesStorage";
import { buildCtx, genTrades, loadSeries, PERIOD_START, LEARN_END, CONFIRM_START, TODAY, CAP_EOK, type Ctx } from "./research-ma-lab";

// ---- 사전 등록 상수 (research/audit-v3-prereg.md) ----
const BASE = { sp: 50, lp: 200, gap: -0.1829, bars: 252 }; // 기존 운영 규칙(v3)
const EXPECT = { cagr: "6.36", mdd: "53.31", trades: 2335 };
const BASE_CAGR_REF = 6.36;
const V1_MAX_DROP_PP = 1.5;
const V2_VARIANTS: { id: string; label: string; p: Partial<typeof BASE> }[] = [
  { id: "m40", label: "이평 (40,160)", p: { sp: 40, lp: 160 } },
  { id: "m60", label: "이평 (60,240)", p: { sp: 60, lp: 240 } },
  { id: "g15", label: "고가 필터 -15%", p: { gap: -0.15 } },
  { id: "g22", label: "고가 필터 -22%", p: { gap: -0.22 } },
  { id: "b200", label: "고가 기간 200봉", p: { bars: 200 } },
  { id: "b300", label: "고가 기간 300봉", p: { bars: 300 } },
];
const V2_MIN_CAGR = 3.64; // 유니버스 동일가중 CAGR
const V2_MIN_PASS = 5;
const V3_EXCLUDE_TRADES = [1, 5, 10, 20, 50];
const V3_EXCLUDE_YEARS = [1, 2];
const V3_PASS_K = 10;
const BOOT_BLOCK_MONTHS = 12;
const BOOT_REPS = 1000;
const BOOT_SEED = 1;
const BOOT_PCTS = [5, 50, 95];
const V5_TRAIN_TOLERANCE_PP = 2;
const MS_DAY = 86_400_000;

interface PricePoint { tradeDate: string; closePrice: number }
interface TR { buyDate: string; sellDate: string; ret: number; days: { d: string; r: number }[] }
interface Book { sum: Map<string, number>; cnt: Map<string, number>; trades: TR[] }
const newBook = (): Book => ({ sum: new Map(), cnt: new Map(), trades: [] });
function addTrade(b: Book, t: TR): void {
  b.trades.push(t);
  for (const { d, r } of t.days) { b.sum.set(d, (b.sum.get(d) ?? 0) + r); b.cnt.set(d, (b.cnt.get(d) ?? 0) + 1); }
}
function withoutTrades(b: Book, excl: Set<TR>): Book {
  const o: Book = { sum: new Map(b.sum), cnt: new Map(b.cnt), trades: b.trades.filter((t) => !excl.has(t)) };
  for (const t of excl) for (const { d, r } of t.days) { o.sum.set(d, (o.sum.get(d) ?? 0) - r); o.cnt.set(d, (o.cnt.get(d) ?? 0) - 1); }
  return o;
}

function nearHighOk(ctx: Ctx, e: number, gap: number, bars: number): boolean {
  let hi = -Infinity;
  for (let j = Math.max(0, e - (bars - 1)); j <= e; j++) if (ctx.prices[j].high > hi) hi = ctx.prices[j].high;
  return ctx.prices[e].close / hi - 1 > gap;
}

/** 기본 ctx(50/200)에서 이평 기간만 바꾼 ctx (buildCtx와 같은 골든/데드 판정). */
function ctxWithMa(base: Ctx, sp: number, lp: number): Ctx {
  if (sp === BASE.sp && lp === BASE.lp) return base;
  const sShort = computeSMA(base.closes, sp), sLong = computeSMA(base.closes, lp);
  const goldens: number[] = [], deads: number[] = [];
  for (let i = 1; i < base.n; i++) {
    const ps = sShort[i - 1], pl = sLong[i - 1], cs = sShort[i], cl = sLong[i];
    if (ps === undefined || pl === undefined || cs === undefined || cl === undefined) continue;
    const prev = ps > pl, cur = cs > cl;
    if (!prev && cur && base.prices[i].date >= PERIOD_START) goldens.push(i);
    else if (prev && !cur && base.prices[i].date >= PERIOD_START) deads.push(i);
  }
  return { ...base, sShort, sLong, goldens, deads };
}

/** 신호 인덱스(e,s)를 shift 거래일 뒤, 종가/시가로 체결하는 거래와 일별 수익률. shift=0·close면 기존 집계와 같다. */
function makeTrade(ctx: Ctx, eIdx: number, sIdx: number, shift: number, mode: "close" | "open"): TR | null {
  const p = ctx.prices, n = ctx.n;
  const b = eIdx + shift, s = Math.min(sIdx + shift, n - 1);
  if (b >= n || s <= b) return null;
  const open = mode === "open";
  const bp = open ? p[b].open : p[b].close, spx = open ? p[s].open : p[s].close;
  if (!(bp > 0) || !(spx > 0)) return null;
  const sellDate = p[s].date;
  const days: { d: string; r: number }[] = [];
  const first = open ? b : b + 1;
  for (let i = first; i <= s; i++) {
    if (p[i].date < PERIOD_START) continue;
    const from = i === b ? p[b].open : p[i - 1].close;
    const to = i === s && open ? p[s].open : p[i].close;
    if (!(from > 0) || !(to > 0)) return null;
    let m = to / from;
    if (i === first) m /= computeEffectiveBuyPrice(bp) / bp;
    if (i === s) m *= computeEffectiveSellPrice(spx, sellDate, "KR") / spx;
    days.push({ d: p[i].date, r: m - 1 });
  }
  return { buyDate: p[b].date, sellDate, ret: computeCostAdjustedReturnPct(bp, spx, sellDate, "KR"), days };
}

const dayDiff = (a: string, b: string): number => (Date.parse(b) - Date.parse(a)) / MS_DAY;
const endCap = (e: string): string => (e > TODAY ? TODAY : e);
const f2 = (x: number): string => x.toFixed(2);
let CAL: string[] = [];

function bookDaily(b: Book, days: string[]): number[] {
  return days.map((d) => { const c = b.cnt.get(d) ?? 0; return c === 0 ? 0 : ((b.sum.get(d) ?? 0) / c) * 100; });
}
function seriesMetrics(dates: string[], rets: number[], start: string, end: string): { cagr: number; mdd: number } {
  const r = rets.filter((_, i) => dates[i] >= start && dates[i] <= end);
  const { totalReturnPct, mddPct } = computeCumulativeAndMdd(r);
  return { cagr: computeCagrPct(totalReturnPct, start, endCap(end)), mdd: mddPct };
}
const seriesYear = (dates: string[], rets: number[], y: number): number =>
  computeCumulativeAndMdd(rets.filter((_, i) => dates[i].startsWith(`${y}-`))).totalReturnPct;
function bookMetrics(b: Book, start: string, end: string) {
  const m = seriesMetrics(CAL, bookDaily(b, CAL), start, end);
  return { ...m, trades: b.trades.filter((t) => t.buyDate >= start && t.buyDate <= end).length };
}
function mulberry32(a: number): () => number {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function pct(sorted: number[], p: number): number {
  const x = (p / 100) * (sorted.length - 1), lo = Math.floor(x), hi = Math.ceil(x);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (x - lo);
}
const SLICES: [string, string, string][] = [["전체 2010~", PERIOD_START, TODAY], ["학습 2010~2018", PERIOD_START, LEARN_END], ["확인 2019~", CONFIRM_START, TODAY]];
const ox = (b: boolean): string => (b ? "O" : "X");

export interface StudyInput { series: Map<string, StockDailyPriceRow[]>; kospi: PricePoint[]; reproGate: boolean }

export async function runStudy(inp: StudyInput): Promise<{ ok: boolean }> {
  const { series } = inp;
  const calSet = new Set<string>();
  for (const rows of series.values()) for (const r of rows) if (r.tradeDate >= PERIOD_START) calSet.add(r.tradeDate);
  CAL = [...calSet].sort();
  const rebalanceDates = computeMonthlyRebalanceDates(CAL);
  console.log(`거래일 캘린더 ${CAL.length}일 ${CAL[0]}~${CAL[CAL.length - 1]}`);

  const ids = ["gen", ...V2_VARIANTS.map((v) => v.id), "d1c", "d1o"];
  const books: Record<string, Book> = { ref: newBook() };
  for (const id of ids) books[id] = newBook();
  let openSkipped = 0, d1Skipped = 0;
  const pricesByStock = new Map<string, { date: string; close: number }[]>();
  const liquidity = new Map<string, Map<string, number>>();
  const variantCtx: { id: string; sp: number; lp: number; gap: number; bars: number }[] = [
    { id: "gen", ...BASE }, ...V2_VARIANTS.map((v) => ({ id: v.id, ...BASE, ...v.p })),
  ];
  for (const [code, rows] of series) {
    const base = buildCtx(code, rows);
    series.delete(code);
    pricesByStock.set(code, base.prices.map((p) => ({ date: p.date, close: p.close })));
    const idx = new Map(base.prices.map((p, i) => [p.date, i]));
    const lq = new Map<string, number>();
    for (const d of rebalanceDates) {
      const i = idx.get(d);
      if (i !== undefined && Number.isFinite(base.avgTv[i]) && rows[i].marketCapEok >= CAP_EOK) lq.set(d, base.avgTv[i]);
    }
    liquidity.set(code, lq);
    // 기준 경로(기존 집계 함수) — 재현 게이트용
    if (base.goldens.length > 0) {
      for (const t of genTrades(base, { name: "v3", entryFilter: (c, e) => nearHighOk(c, e, BASE.gap, BASE.bars) })) {
        const tmp: DailyStockReturns = new Map();
        accumulateStockDailyReturns(tmp, new Map(), code, base.prices, [t], PERIOD_START, "KR", true);
        addTrade(books.ref, { buyDate: t.buyDate, sellDate: t.sellDate, ret: t.returnPct, days: [...tmp.entries()].map(([d, es]) => ({ d, r: es[0].returnPct })) });
      }
    }
    // 일반화 경로: 기본 + V2 변형 + V1 지연
    for (const v of variantCtx) {
      const ctx = ctxWithMa(base, v.sp, v.lp);
      if (ctx.goldens.length === 0) continue;
      for (const t of genTrades(ctx, { name: v.id, entryFilter: (c, e) => nearHighOk(c, e, v.gap, v.bars) })) {
        const tr = makeTrade(ctx, t.eIdx, t.sIdx, 0, "close");
        if (tr) addTrade(books[v.id], tr);
        if (v.id === "gen") {
          const a = makeTrade(ctx, t.eIdx, t.sIdx, 1, "close");
          if (a) addTrade(books.d1c, a); else d1Skipped++;
          const o = makeTrade(ctx, t.eIdx, t.sIdx, 1, "open");
          if (o) addTrade(books.d1o, o); else openSkipped++;
        }
      }
    }
  }

  // ---- 0) 재현 ----
  const b0 = bookMetrics(books.ref, PERIOD_START, TODAY);
  console.log(`\n=== 0) 상한 없는 v3 재현 확인 ===`);
  console.log(`하네스(기존 집계): CAGR ${f2(b0.cagr)}% | MDD ${f2(b0.mdd)}% | 거래 ${b0.trades}건`);
  console.log(`사전 등록 기준: CAGR ${EXPECT.cagr}% | MDD ${EXPECT.mdd}% | 거래 ${EXPECT.trades}건`);
  const match = f2(b0.cagr) === EXPECT.cagr && f2(b0.mdd) === EXPECT.mdd && b0.trades === EXPECT.trades;
  console.log(`재현 결과: ${match ? "일치" : "불일치"}`);
  const g0 = bookMetrics(books.gen, PERIOD_START, TODAY);
  console.log(`일관성 점검(일반화 경로, 기본 파라미터): CAGR ${f2(g0.cagr)}% | MDD ${f2(g0.mdd)}% | 거래 ${g0.trades}건 | ${f2(g0.cagr) === f2(b0.cagr) && f2(g0.mdd) === f2(b0.mdd) && g0.trades === b0.trades ? "일치" : "불일치"}`);
  if (inp.reproGate && !match) {
    console.log("재현이 어긋나 중단합니다. (원인 후보: 데이터 범위(연도 파일)·조정계수 적용 차이, 집계 구현 차이)");
    return { ok: false };
  }
  const base = books.ref;

  const uRets = simulateUniverseMonthlyRebalance(
    pricesByStock, CAL, PERIOD_START,
    (code, date) => (liquidity.get(code)?.get(date) ?? NaN) >= PIT_MIN_AVG_TRADING_VALUE_WON, true
  );
  const uni = seriesMetrics(CAL, uRets, PERIOD_START, TODAY);

  // ---- V1 ----
  console.log(`\n=== V1 체결 지연 ===`);
  console.log(`(제외: 종가 지연 ${d1Skipped}건, 시가 지연 ${openSkipped}건 — 데이터 끝/유효하지 않은 시가)`);
  console.log("| 체결 | 전체 CAGR % | 전체 MDD % | 거래 수 | 학습 CAGR % | 확인 CAGR % |");
  console.log("|---|---|---|---|---|---|");
  const v1rows: [string, Book][] = [["기준(신호일 종가)", base], ["(a) 다음 거래일 종가", books.d1c], ["(b) 다음 거래일 시가", books.d1o]];
  for (const [lab, b] of v1rows) {
    const m = bookMetrics(b, PERIOD_START, TODAY), tr = bookMetrics(b, PERIOD_START, LEARN_END), cf = bookMetrics(b, CONFIRM_START, TODAY);
    console.log(`| ${lab} | ${f2(m.cagr)} | ${f2(m.mdd)} | ${m.trades} | ${f2(tr.cagr)} | ${f2(cf.cagr)} |`);
  }
  const aM = bookMetrics(books.d1c, PERIOD_START, TODAY);
  const v1Drop = BASE_CAGR_REF - aM.cagr;
  const v1Pass = v1Drop <= V1_MAX_DROP_PP;

  // ---- V2 ----
  console.log(`\n=== V2 민감도 (하나씩 변경) ===`);
  console.log("| 변형 | 전체 CAGR % | 전체 MDD % | 거래 수 | 학습 CAGR % | 확인 CAGR % |");
  console.log("|---|---|---|---|---|---|");
  const v2rows: [string, Book][] = [["기준 (50,200)/-18.29%/252봉", books.gen], ...V2_VARIANTS.map((v): [string, Book] => [v.label, books[v.id]])];
  let v2Count = 0;
  for (const [i, [lab, b]] of v2rows.entries()) {
    const m = bookMetrics(b, PERIOD_START, TODAY), tr = bookMetrics(b, PERIOD_START, LEARN_END), cf = bookMetrics(b, CONFIRM_START, TODAY);
    if (i > 0 && m.cagr >= V2_MIN_CAGR) v2Count++;
    console.log(`| ${lab} | ${f2(m.cagr)} | ${f2(m.mdd)} | ${m.trades} | ${f2(tr.cagr)} | ${f2(cf.cagr)} |`);
  }
  console.log(`유니버스 동일가중(참고) 전체 CAGR ${f2(uni.cagr)} / MDD ${f2(uni.mdd)}`);

  // ---- V3 ----
  console.log(`\n=== V3 집중도 ===`);
  const sorted = [...base.trades].filter((t) => t.buyDate >= PERIOD_START).sort((a, b) => b.ret - a.ret || a.buyDate.localeCompare(b.buyDate));
  console.log("| 제외 | 전체 CAGR % | 전체 MDD % | 남은 거래 수 | 제외 거래 수익률 합계(단순합 %) |");
  console.log("|---|---|---|---|---|");
  const b00 = bookMetrics(base, PERIOD_START, TODAY);
  console.log(`| 없음(기준) | ${f2(b00.cagr)} | ${f2(b00.mdd)} | ${b00.trades} | - |`);
  let v3TopPass = false;
  for (const k of V3_EXCLUDE_TRADES) {
    const ex = new Set(sorted.slice(0, k));
    const m = bookMetrics(withoutTrades(base, ex), PERIOD_START, TODAY);
    if (k === V3_PASS_K) v3TopPass = m.cagr > 0;
    console.log(`| 상위 ${k}건 | ${f2(m.cagr)} | ${f2(m.mdd)} | ${m.trades} | ${f2(sorted.slice(0, k).reduce((a, t) => a + t.ret, 0) * 100)} |`);
  }
  console.log(`상위 10건 거래(진입일 / 청산일 / 수익률 %): ${sorted.slice(0, 10).map((t) => `${t.buyDate}~${t.sellDate} ${f2(t.ret * 100)}`).join(" ; ")}`);
  const bDaily = bookDaily(base, CAL);
  const years: number[] = [];
  for (let y = 2010; y <= Number(TODAY.slice(0, 4)); y++) years.push(y);
  const yRet = years.map((y) => ({ y, r: seriesYear(CAL, bDaily, y) }));
  const yDays = (y: number): number => dayDiff(y === 2010 ? PERIOD_START : `${y}-01-01`, endCap(`${y}-12-31`)) + 1;
  console.log(`연도별 수익률 %: ${yRet.map((x) => `${x.y}: ${f2(x.r)}`).join(", ")}`);
  const rankedY = [...yRet].sort((a, b) => b.r - a.r);
  console.log("| 제외 연도 | 제외한 연도 | 남은 연수 | CAGR % |");
  console.log("|---|---|---|---|");
  for (const k of V3_EXCLUDE_YEARS) {
    const exY = new Set(rankedY.slice(0, k).map((x) => x.y));
    const keep = CAL.map((d, i) => (exY.has(Number(d.slice(0, 4))) ? -1 : i)).filter((i) => i >= 0);
    const { totalReturnPct } = computeCumulativeAndMdd(keep.map((i) => bDaily[i]));
    const yrs = years.filter((y) => !exY.has(y)).reduce((a, y) => a + yDays(y), 0) / 365.25;
    const cagr = ((1 + totalReturnPct / 100) ** (1 / yrs) - 1) * 100;
    console.log(`| 상위 ${k}개 연도 | ${[...exY].join(", ")} | ${yrs.toFixed(2)} | ${f2(cagr)} |`);
  }

  // ---- V4 ----
  const monthly = new Map<string, number>();
  CAL.forEach((d, i) => { const m = d.slice(0, 7); monthly.set(m, (monthly.get(m) ?? 1) * (1 + bDaily[i] / 100)); });
  const mr = [...monthly.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, v]) => v - 1);
  const n = mr.length;
  const cagrOf = (r: number[]): number => (Math.exp((12 / r.length) * r.reduce((a, x) => a + Math.log(1 + x), 0)) - 1) * 100;
  const rng = mulberry32(BOOT_SEED);
  const samples: number[] = [];
  for (let b = 0; b < BOOT_REPS; b++) {
    const r: number[] = [];
    while (r.length < n) { const s0 = Math.floor(rng() * (n - BOOT_BLOCK_MONTHS + 1)); for (let j = 0; j < BOOT_BLOCK_MONTHS; j++) r.push(mr[s0 + j]); }
    samples.push(cagrOf(r.slice(0, n)));
  }
  samples.sort((a, b) => a - b);
  console.log(`\n=== V4 불확실성: 월 수익률 ${BOOT_BLOCK_MONTHS}개월 블록 부트스트랩 ${BOOT_REPS}회 (월 ${n}개, 시드 ${BOOT_SEED}) ===`);
  console.log(`관측 CAGR(월 수익률 기반) ${f2(cagrOf(mr))}%`);
  console.log("| 백분위 | CAGR % |");
  console.log("|---|---|");
  for (const p of BOOT_PCTS) console.log(`| ${p} | ${f2(pct(samples, p))} |`);
  const v4Pass = pct(samples, 5) >= 0;

  // ---- V5 ----
  console.log(`\n=== V5 노출 보정 (w = 보유 종목 1개 이상인 날의 비율) ===`);
  console.log("| 구간 | w % | 평균 보유 종목 | v3 CAGR | v3 MDD | 보정 동일가중 CAGR | 보정 동일가중 MDD | 동일가중(100%) CAGR | 동일가중(100%) MDD |");
  console.log("|---|---|---|---|---|---|---|---|---|");
  const v5: Record<string, { v: number; u: number }> = {};
  for (const [lab, s, e] of SLICES) {
    const days = CAL.filter((d) => d >= s && d <= e);
    const w = days.filter((d) => (base.cnt.get(d) ?? 0) > 0).length / Math.max(days.length, 1);
    const hold = days.reduce((a, d) => a + (base.cnt.get(d) ?? 0), 0) / Math.max(days.length, 1);
    const v = seriesMetrics(CAL, bDaily, s, e), bl = seriesMetrics(CAL, uRets.map((x) => x * w), s, e), u = seriesMetrics(CAL, uRets, s, e);
    v5[lab] = { v: v.cagr, u: bl.cagr };
    console.log(`| ${lab} | ${f2(w * 100)} | ${hold.toFixed(1)} | ${f2(v.cagr)} | ${f2(v.mdd)} | ${f2(bl.cagr)} | ${f2(bl.mdd)} | ${f2(u.cagr)} | ${f2(u.mdd)} |`);
  }
  const [fl, tl, cl] = SLICES.map((s) => s[0]);
  const v5Pass = v5[fl].v > v5[fl].u && v5[cl].v > v5[cl].u && v5[tl].v >= v5[tl].u - V5_TRAIN_TOLERANCE_PP;

  // ---- 판정표 ----
  console.log(`\n=== 사전 판정 기준 (O/X) ===`);
  console.log("| 항목 | 측정값 | 기준 | 결과 |");
  console.log("|---|---|---|---|");
  console.log(`| V1 | (a) CAGR ${f2(aM.cagr)}, 하락폭 ${f2(v1Drop)}%p | 하락폭 <= ${V1_MAX_DROP_PP}%p | ${ox(v1Pass)} |`);
  console.log(`| V2 | CAGR >= ${V2_MIN_CAGR}% 변형 ${v2Count}/${V2_VARIANTS.length}개 | >= ${V2_MIN_PASS}개 | ${ox(v2Count >= V2_MIN_PASS)} |`);
  console.log(`| V3 | 상위 ${V3_PASS_K}건 제외 CAGR ${f2(bookMetrics(withoutTrades(base, new Set(sorted.slice(0, V3_PASS_K))), PERIOD_START, TODAY).cagr)} | > 0 | ${ox(v3TopPass)} |`);
  console.log(`| V4 | 5백분위 ${f2(pct(samples, 5))} | >= 0 | ${ox(v4Pass)} |`);
  console.log(`| V5 | 전체 ${f2(v5[fl].v)} vs ${f2(v5[fl].u)}, 학습 ${f2(v5[tl].v)} vs ${f2(v5[tl].u)}, 확인 ${f2(v5[cl].v)} vs ${f2(v5[cl].u)} | 전체·확인 v3 우위, 학습 -${V5_TRAIN_TOLERANCE_PP}%p 이내 | ${ox(v5Pass)} |`);
  const oc = [v1Pass, v2Count >= V2_MIN_PASS, v3TopPass, v4Pass, v5Pass].filter(Boolean).length;
  console.log(`O 개수: ${oc}/5 → 종합 표기: ${oc >= 4 ? "신뢰 가능(조건부)" : oc >= 2 ? "불확실" : "신뢰 어려움"}`);
  console.log("\n감사(시도 횟수에 포함하지 않음)\n완료");
  return { ok: true };
}

async function main(): Promise<void> {
  console.log(`v3 재검증 감사 시작(in-sample): ${new Date().toISOString()}`);
  const series = await loadSeries();
  const kospi = await getIndexPriceSeries("KOSPI", PERIOD_START, TODAY);
  const { ok } = await runStudy({ series, kospi, reproGate: true });
  if (!ok) process.exit(2);
}
if (process.argv[1] && process.argv[1].endsWith("research-audit-v3.ts")) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
