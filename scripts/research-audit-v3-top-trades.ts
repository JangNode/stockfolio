/**
 * [임시 점검 — 병합 금지, 읽기 전용] v3 수익률 상위 거래 데이터 점검(T1~T5).
 * 사전 등록: research/audit-v3-top-trades-prereg.md. DB는 stock_price_adjustment_events 조회만. 판정·추천 없이 숫자만 출력한다.
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchAllRows } from "@/lib/supabasePagination";
import { loadAllStockSeriesFromParquet, type StockDailyPriceRow } from "@/lib/stockDailyPricesStorage";
import { applyAdjustmentsInPlace, type AppliedAdjustment } from "@/lib/priceAdjustment";
import { accumulateStockDailyReturns, computeCumulativeAndMdd, computeCagrPct, type DailyStockReturns } from "@/lib/strategyBacktestSummary";
import { buildCtx, genTrades, PERIOD_START, LEARN_END, CONFIRM_START, TODAY, type Ctx } from "./research-ma-lab";

// ---- 사전 등록 상수 (research/audit-v3-top-trades-prereg.md) ----
const NEAR_HIGH_MIN_GAP = -0.1829;
const NEAR_HIGH_BARS = 252;
const EXPECT = { cagr: "6.36", mdd: "53.31", trades: 2335 };
const TOP_N = 30;
const KEEP_RET_THRESHOLD = 1.0; // 비용 반영 수익률 100% 초과 거래의 종목 행만 보존
const ENDED_GRACE_DAYS = 14;
const GAP_DAYS = 5;
const MS_DAY = 86_400_000;

type Cat = "데드크로스 청산" | "데이터 끝 강제청산" | "미청산 평가";
interface TR { code: string; buyDate: string; sellDate: string; ret: number; cat: Cat; eIdx: number; sIdx: number; days: { d: string; r: number }[] }
interface Book { sum: Map<string, number>; cnt: Map<string, number>; trades: TR[] }
interface Ev { stock_code: string; event_date: string; adjustment_factor: number; status: string }
interface Kept { code: string; raw: StockDailyPriceRow[]; adj: StockDailyPriceRow[] }

const newBook = (): Book => ({ sum: new Map(), cnt: new Map(), trades: [] });
function addTrade(b: Book, t: TR): void {
  b.trades.push(t);
  for (const { d, r } of t.days) { b.sum.set(d, (b.sum.get(d) ?? 0) + r); b.cnt.set(d, (b.cnt.get(d) ?? 0) + 1); }
}
function withoutTrades(b: Book, pred: (t: TR) => boolean): Book {
  const o: Book = { sum: new Map(b.sum), cnt: new Map(b.cnt), trades: [] };
  for (const t of b.trades) {
    if (!pred(t)) { o.trades.push(t); continue; }
    for (const { d, r } of t.days) { o.sum.set(d, (o.sum.get(d) ?? 0) - r); o.cnt.set(d, (o.cnt.get(d) ?? 0) - 1); }
  }
  return o;
}
function nearHighOk(ctx: Ctx, e: number): boolean {
  let hi = -Infinity;
  for (let j = Math.max(0, e - (NEAR_HIGH_BARS - 1)); j <= e; j++) if (ctx.prices[j].high > hi) hi = ctx.prices[j].high;
  return ctx.prices[e].close / hi - 1 > NEAR_HIGH_MIN_GAP;
}
/** 감사 스크립트(research-audit-v3.ts)의 makeTrade(shift=0, close)와 같은 조건. 제외 사유를 함께 돌려준다. */
function makeTradeGeneric(ctx: Ctx, eIdx: number, sIdx: number): { ok: boolean; reason?: string } {
  const p = ctx.prices, n = ctx.n;
  const b = eIdx, s = Math.min(sIdx, n - 1);
  if (b >= n || s <= b) return { ok: false, reason: `진입 인덱스(${b}) >= 청산 인덱스(${s})` };
  if (!(p[b].close > 0) || !(p[s].close > 0)) return { ok: false, reason: "가격 <= 0" };
  for (let i = b + 1; i <= s; i++) {
    if (p[i].date < PERIOD_START) continue;
    if (!(p[i - 1].close > 0) || !(p[i].close > 0)) return { ok: false, reason: "일별 수익률 계산 불가" };
  }
  return { ok: true };
}

const dayDiff = (a: string, b: string): number => (Date.parse(b) - Date.parse(a)) / MS_DAY;
const endCap = (e: string): string => (e > TODAY ? TODAY : e);
const f2 = (x: number): string => x.toFixed(2);
const mean = (v: number[]): number => (v.length ? v.reduce((a, x) => a + x, 0) / v.length : NaN);
const median = (v: number[]): number => { if (!v.length) return NaN; const s = [...v].sort((a, b) => a - b); const h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
let CAL: string[] = [];
function bookDaily(b: Book): number[] {
  return CAL.map((d) => { const c = b.cnt.get(d) ?? 0; return c === 0 ? 0 : ((b.sum.get(d) ?? 0) / c) * 100; });
}
function bookMetrics(b: Book, start: string, end: string) {
  const daily = bookDaily(b).filter((_, i) => CAL[i] >= start && CAL[i] <= end);
  const { totalReturnPct, mddPct } = computeCumulativeAndMdd(daily);
  return { cagr: computeCagrPct(totalReturnPct, start, endCap(end)), mdd: mddPct, trades: b.trades.filter((t) => t.buyDate >= start && t.buyDate <= end).length };
}
const SLICES: [string, string, string][] = [["전체 2010~", PERIOD_START, TODAY], ["학습 2010~2018", PERIOD_START, LEARN_END], ["확인 2019~", CONFIRM_START, TODAY]];

export interface StudyInput { series: Map<string, StockDailyPriceRow[]>; events: Ev[]; reproGate: boolean }

export async function runStudy(inp: StudyInput): Promise<{ ok: boolean }> {
  const { series, events } = inp;
  const evByCode = new Map<string, Ev[]>();
  const adjByCode = new Map<string, AppliedAdjustment[]>();
  for (const e of events) {
    (evByCode.get(e.stock_code) ?? evByCode.set(e.stock_code, []).get(e.stock_code)!).push(e);
    if (e.status === "applied") (adjByCode.get(e.stock_code) ?? adjByCode.set(e.stock_code, []).get(e.stock_code)!).push({ eventDate: e.event_date, factor: Number(e.adjustment_factor) });
  }
  for (const l of adjByCode.values()) l.sort((a, b) => a.eventDate.localeCompare(b.eventDate));

  const calSet = new Set<string>();
  let globalLast = "";
  for (const rows of series.values()) {
    for (const r of rows) if (r.tradeDate >= PERIOD_START) calSet.add(r.tradeDate);
    if (rows.length && rows[rows.length - 1].tradeDate > globalLast) globalLast = rows[rows.length - 1].tradeDate;
  }
  CAL = [...calSet].sort();
  const endedBefore = new Date(Date.parse(globalLast) - ENDED_GRACE_DAYS * MS_DAY).toISOString().slice(0, 10);
  console.log(`거래일 캘린더 ${CAL.length}일 ${CAL[0]}~${CAL[CAL.length - 1]}, 종료 판정 기준일 ${endedBefore}`);

  const book = newBook();
  const kept = new Map<string, Kept>();
  const dropped: { code: string; buyDate: string; sellDate: string; e: number; s: number; n: number; refDays: number; reason: string }[] = [];
  for (const [code, raw] of series) {
    const adjList = adjByCode.get(code);
    let adj = raw;
    if (adjList) { adj = raw.map((r) => ({ ...r })); applyAdjustmentsInPlace(adj, adjList); }
    const ctx = buildCtx(code, adj);
    series.delete(code);
    if (ctx.goldens.length === 0) continue;
    const lastDate = raw[raw.length - 1].tradeDate;
    let keep = false;
    for (const t of genTrades(ctx, { name: "v3", entryFilter: (c, e) => nearHighOk(c, e) })) {
      const forced = t.isForcedLiquidation === true;
      const cat: Cat = !forced ? "데드크로스 청산" : lastDate < endedBefore ? "데이터 끝 강제청산" : "미청산 평가";
      const tmp: DailyStockReturns = new Map();
      accumulateStockDailyReturns(tmp, new Map(), code, ctx.prices, [t], PERIOD_START, "KR", true);
      const days = [...tmp.entries()].map(([d, es]) => ({ d, r: es[0].returnPct }));
      addTrade(book, { code, buyDate: t.buyDate, sellDate: t.sellDate, ret: t.returnPct, cat, eIdx: t.eIdx, sIdx: t.sIdx, days });
      const g = makeTradeGeneric(ctx, t.eIdx, t.sIdx);
      if (!g.ok) dropped.push({ code, buyDate: t.buyDate, sellDate: t.sellDate, e: t.eIdx, s: t.sIdx, n: ctx.n, refDays: days.length, reason: g.reason! });
      if (t.returnPct > KEEP_RET_THRESHOLD) keep = true;
    }
    if (keep) kept.set(code, { code, raw, adj });
  }

  // ---- 0) 재현 ----
  const b0 = bookMetrics(book, PERIOD_START, TODAY);
  console.log(`\n=== 0) 상한 없는 v3 재현 확인 ===`);
  console.log(`하네스: CAGR ${f2(b0.cagr)}% | MDD ${f2(b0.mdd)}% | 거래 ${b0.trades}건`);
  console.log(`사전 등록 기준: CAGR ${EXPECT.cagr}% | MDD ${EXPECT.mdd}% | 거래 ${EXPECT.trades}건`);
  const match = f2(b0.cagr) === EXPECT.cagr && f2(b0.mdd) === EXPECT.mdd && b0.trades === EXPECT.trades;
  console.log(`재현 결과: ${match ? "일치" : "불일치"}`);
  if (inp.reproGate && !match) {
    console.log("재현이 어긋나 중단합니다. (원인 후보: 데이터 범위(연도 파일)·조정계수 적용 차이, 집계 구현 차이)");
    return { ok: false };
  }

  // ---- T1 / T2 ----
  const all = book.trades.filter((t) => t.buyDate >= PERIOD_START).sort((a, b) => b.ret - a.ret || a.buyDate.localeCompare(b.buyDate));
  const top = all.slice(0, TOP_N);
  const missing = top.filter((t) => !kept.has(t.code));
  console.log(`\n수익률 ${KEEP_RET_THRESHOLD * 100}% 초과 거래 ${all.filter((t) => t.ret > KEEP_RET_THRESHOLD).length}건, 보존 종목 ${kept.size}개, 상위 ${top.length}건 중 행 미보존 ${missing.length}건`);
  console.log(`\n=== T1 수익률 상위 ${TOP_N}건 ===`);
  console.log("| # | 종목 | 진입일 | 청산일 | 분류 | 진입가 조정/원본 | 청산가 조정/원본 | 보유 거래일/달력일 | 수익률 % (비용 반영) | 원본 종가 수익률 % | 진입일 시총(억) |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|");
  const t2: string[] = [];
  top.forEach((t, k) => {
    const kp = kept.get(t.code);
    if (!kp) { console.log(`| ${k + 1} | ${t.code} | ${t.buyDate} | ${t.sellDate} | ${t.cat} | (행 미보존) | | | ${f2(t.ret * 100)} | | |`); return; }
    const { raw, adj } = kp;
    const ea = adj[t.eIdx].closePrice, sa = adj[t.sIdx].closePrice, er = raw[t.eIdx].closePrice, sr = raw[t.sIdx].closePrice;
    console.log(`| ${k + 1} | ${t.code} | ${t.buyDate} | ${t.sellDate} | ${t.cat} | ${ea.toFixed(2)} / ${er.toFixed(2)} | ${sa.toFixed(2)} / ${sr.toFixed(2)} | ${t.sIdx - t.eIdx} / ${dayDiff(t.buyDate, t.sellDate)} | ${f2(t.ret * 100)} | ${f2((sr / er - 1) * 100)} | ${raw[t.eIdx].marketCapEok.toFixed(0)} |`);

    const evs = (evByCode.get(t.code) ?? []).filter((e) => (e.status === "applied" || e.status === "low_confidence") && e.event_date > t.buyDate && e.event_date <= t.sellDate);
    const evDates = new Set((evByCode.get(t.code) ?? []).filter((e) => e.status === "applied" || e.status === "low_confidence").map((e) => e.event_date));
    let maxUp = -Infinity, maxUpD = "", maxDn = Infinity, maxDnD = "", rUp = -Infinity, rUpD = "", rDn = Infinity, rDnD = "";
    let shChg = 0, shChgNoEv = 0, gaps = 0, maxGap = 0;
    for (let i = t.eIdx + 1; i <= t.sIdx; i++) {
      const r = adj[i].closePrice / adj[i - 1].closePrice - 1, rr = raw[i].closePrice / raw[i - 1].closePrice - 1;
      if (r > maxUp) { maxUp = r; maxUpD = adj[i].tradeDate; } if (r < maxDn) { maxDn = r; maxDnD = adj[i].tradeDate; }
      if (rr > rUp) { rUp = rr; rUpD = raw[i].tradeDate; } if (rr < rDn) { rDn = rr; rDnD = raw[i].tradeDate; }
      const a = raw[i].listedShares, b = raw[i - 1].listedShares;
      if (a > 0 && b > 0 && a !== b) { shChg++; if (!evDates.has(raw[i].tradeDate)) shChgNoEv++; }
      const gp = dayDiff(raw[i - 1].tradeDate, raw[i].tradeDate);
      if (gp > GAP_DAYS) { gaps++; if (gp > maxGap) maxGap = gp; }
    }
    t2.push(`| ${k + 1} | ${t.code} | ${evs.length} | ${evs.map((e) => `${e.event_date} ${e.status} ${Number(e.adjustment_factor).toFixed(4)}`).join("; ") || "-"} | +${f2(maxUp * 100)} (${maxUpD}) / ${f2(maxDn * 100)} (${maxDnD}) | +${f2(rUp * 100)} (${rUpD}) / ${f2(rDn * 100)} (${rDnD}) | ${shChg} / ${shChgNoEv} | ${gaps} / ${maxGap} |`);
  });
  console.log(`\n=== T2 상위 ${TOP_N}건 보유 중 데이터 점검 ===`);
  console.log("| # | 종목 | 이벤트 수 | 이벤트(날짜 상태 계수) | 하루 최대 상승/하락 % (조정 기준) | 하루 최대 상승/하락 % (원본) | 상장주식수 변경일 전체 / 이벤트 없는 날 | 5일 초과 공백 구간 수 / 최대 공백일 |");
  console.log("|---|---|---|---|---|---|---|---|");
  for (const l of t2) console.log(l);

  // ---- T3 ----
  console.log(`\n=== T3 청산 방식 구분 (전체 거래, 진입일 >= ${PERIOD_START}) ===`);
  console.log("| 분류 | 전체 건수 | 평균 수익률 % | 상위 30건 중 건수 |");
  console.log("|---|---|---|---|");
  const cats: Cat[] = ["데드크로스 청산", "데이터 끝 강제청산", "미청산 평가"];
  for (const c of cats) {
    const l = all.filter((t) => t.cat === c);
    console.log(`| ${c} | ${l.length} | ${f2(mean(l.map((t) => t.ret)) * 100)} | ${top.filter((t) => t.cat === c).length} |`);
  }
  const open = all.filter((t) => t.cat === "미청산 평가");
  console.log(`미청산 평가 포지션 ${open.length}건 | 평가수익 단순 합 ${f2(open.reduce((a, t) => a + t.ret, 0) * 100)}% | 평균 ${f2(mean(open.map((t) => t.ret)) * 100)}% | 중앙값 ${f2(median(open.map((t) => t.ret)) * 100)}%`);

  // ---- T4 ----
  console.log(`\n=== T4 미청산 포지션 제외 ===`);
  console.log("| 구성 | 구간 | CAGR % | MDD % | 거래 수 |");
  console.log("|---|---|---|---|---|");
  const noOpen = withoutTrades(book, (t) => t.cat === "미청산 평가");
  const noForced = withoutTrades(book, (t) => t.cat !== "데드크로스 청산");
  for (const [lab, b] of [["기준(제외 없음)", book], ["미청산 평가 제외", noOpen], ["미청산 평가 + 데이터 끝 강제청산 제외", noForced]] as [string, Book][]) {
    for (const [sl, s, e] of SLICES) {
      const m = bookMetrics(b, s, e);
      console.log(`| ${lab} | ${sl} | ${f2(m.cagr)} | ${f2(m.mdd)} | ${m.trades} |`);
    }
  }

  // ---- T5 ----
  console.log(`\n=== T5 집계 경로(${book.trades.length}건) vs 일반화 경로(${book.trades.length - dropped.length}건) 차이 ${dropped.length}건 ===`);
  console.log("| 종목 | 진입일 | 청산일 | 진입 인덱스 | 청산 인덱스 | 종목 행 수 | 집계 경로 일별 수익률 일수 | 일반화 경로 제외 사유 |");
  console.log("|---|---|---|---|---|---|---|---|");
  for (const d of dropped) console.log(`| ${d.code} | ${d.buyDate} | ${d.sellDate} | ${d.e} | ${d.s} | ${d.n} | ${d.refDays} | ${d.reason} |`);
  console.log("\n점검(시도 횟수에 포함하지 않음)\n완료");
  return { ok: true };
}

async function main(): Promise<void> {
  console.log(`v3 상위 거래 데이터 점검 시작(읽기 전용): ${new Date().toISOString()}`);
  const events = await fetchAllRows<Ev>((from, to) =>
    supabaseAdmin.from("stock_price_adjustment_events")
      .select("stock_code, event_date, adjustment_factor, status")
      .order("stock_code").order("event_date").range(from, to)
  );
  console.log(`가격조정 이벤트 ${events.length}건 조회`);
  const series = await loadAllStockSeriesFromParquet(2010, new Date().getUTCFullYear()); // 원본(조정 전)
  console.log(`종목 ${series.size}개 로드, heap ${(process.memoryUsage().heapUsed / 1048576).toFixed(0)}MB`);
  const { ok } = await runStudy({ series, events, reproGate: true });
  if (!ok) process.exit(2);
}
if (process.argv[1] && process.argv[1].endsWith("research-audit-v3-top-trades.ts")) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
