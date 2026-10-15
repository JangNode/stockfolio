/**
 * [임시 연구 — 병합 금지, 읽기 전용] 새 전략 3종(S-A 상대 모멘텀 / S-B 저변동성 / S-C 모멘텀+KOSPI 200일선 필터) 월간 리밸런싱 실행기.
 * 사전 등록: research/new-strategies-prereg.md. 판정·추천 없이 숫자만 출력한다.
 */
import { getIndexPriceSeries } from "@/lib/betaPriceHistoryStorage";
import { PIT_MIN_AVG_TRADING_VALUE_WON } from "@/lib/strategyBacktestSummaryConfig";
import { accumulateStockDailyReturns, computeCumulativeAndMdd, computeCagrPct, type DailyStockReturns } from "@/lib/strategyBacktestSummary";
import { computeIndexDailyReturnsPct, simulateUniverseMonthlyRebalance, computeMonthlyRebalanceDates } from "@/lib/benchmarkSummary";
import { computeEffectiveBuyPrice, computeEffectiveSellPrice } from "@/lib/transactionCost";
import { computeSMA } from "@/lib/sma";
import type { StockDailyPriceRow } from "@/lib/stockDailyPricesStorage";
import { buildCtx, genTrades, loadSeries, PERIOD_START, LEARN_END, CONFIRM_START, TODAY, CAP_EOK, type Ctx } from "./research-ma-lab";

// ---- 사전 등록 상수 (research/new-strategies-prereg.md) ----
const N_HOLD = 20;
const MOM_SKIP_DAYS = 21; // 수익률 종점: t-21거래일
const MOM_LOOKBACK_DAYS = 252; // 수익률 시점: t-252거래일
const VOL_WINDOW_DAYS = 252;
const VOL_MIN_ROWS = 200;
const KOSPI_MA_DAYS = 200;
const PRICE_ASOF_MAX_GAP_DAYS = 10;
const ENDED_GRACE_DAYS = 14;
const NEAR_HIGH_MIN_GAP = -0.1829; // v3 재현용(기존 운영 규칙)
const NEAR_HIGH_BARS = 252;
const EXPECT = { cagr: "6.36", mdd: "53.31", trades: 2335 };
const PRIOR_ATTEMPTS = 51;
const PASS = { fullCagr: 8.46, fullMdd: 50, trainCagr: 2.2, confirmCagr: 5.33 };
const MS_DAY = 86_400_000;

interface PricePoint { tradeDate: string; closePrice: number }
interface Sk { code: string; dates: string[]; close: Float64Array; mcap: Float64Array; avgTv: Float64Array; idx: Map<string, number> }
interface TR { buyDate: string; sellDate: string; ret: number; days: { d: string; r: number }[] }
type Kind = "A" | "B" | "C";

function nearHighOk(ctx: Ctx, e: number): boolean {
  let hi = -Infinity;
  for (let j = Math.max(0, e - (NEAR_HIGH_BARS - 1)); j <= e; j++) if (ctx.prices[j].high > hi) hi = ctx.prices[j].high;
  return ctx.prices[e].close / hi - 1 > NEAR_HIGH_MIN_GAP;
}

const dayDiff = (a: string, b: string): number => (Date.parse(b) - Date.parse(a)) / MS_DAY;
/** dates에서 date 이하인 마지막 인덱스(없으면 -1). */
function lastOnOrBefore(dates: string[], date: string): number {
  let lo = 0, hi = dates.length - 1, f = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (dates[m] <= date) { f = m; lo = m + 1; } else hi = m - 1; }
  return f;
}
function priceAsOf(sk: Sk, date: string): number {
  const j = lastOnOrBefore(sk.dates, date);
  if (j < 0 || dayDiff(sk.dates[j], date) > PRICE_ASOF_MAX_GAP_DAYS) return NaN;
  return sk.close[j];
}

/** 리밸런싱일 t의 종목 선택. 동점은 종목코드 오름차순. */
function selectStocks(kind: "A" | "B", stocks: Sk[], cal: string[], k: number): string[] {
  if (k < MOM_LOOKBACK_DAYS) return [];
  const t = cal[k];
  const cand: { code: string; score: number }[] = [];
  for (const sk of stocks) {
    const i = sk.idx.get(t);
    if (i === undefined || i < 1) continue;
    if (!(sk.mcap[i - 1] >= CAP_EOK) || !(sk.avgTv[i] >= PIT_MIN_AVG_TRADING_VALUE_WON)) continue;
    if (kind === "A") {
      const p1 = priceAsOf(sk, cal[k - MOM_SKIP_DAYS]), p0 = priceAsOf(sk, cal[k - MOM_LOOKBACK_DAYS]);
      if (!Number.isFinite(p1) || !Number.isFinite(p0) || p0 <= 0) continue;
      cand.push({ code: sk.code, score: p1 / p0 - 1 });
    } else {
      const j = lastOnOrBefore(sk.dates, cal[k - VOL_WINDOW_DAYS]);
      if (i - j < VOL_MIN_ROWS) continue;
      const rs: number[] = [];
      for (let m = Math.max(j + 1, 1); m <= i; m++) rs.push(sk.close[m] / sk.close[m - 1] - 1);
      if (rs.length < 2) continue;
      const mu = rs.reduce((a, x) => a + x, 0) / rs.length;
      cand.push({ code: sk.code, score: Math.sqrt(rs.reduce((a, x) => a + (x - mu) ** 2, 0) / (rs.length - 1)) });
    }
  }
  cand.sort((a, b) => (kind === "A" ? b.score - a.score : a.score - b.score) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  return cand.slice(0, N_HOLD).map((c) => c.code);
}

interface SimOut { dates: string[]; ret: number[]; hold: number[]; cashShare: number[]; turn: { d: string; v: number }[]; orders: { d: string; n: number }[] }

function simulate(kind: Kind, stocks: Sk[], cal: string[], kospi: PricePoint[]): SimOut {
  const byCode = new Map(stocks.map((s) => [s.code, s]));
  const globalLast = cal[cal.length - 1];
  const endedBefore = new Date(Date.parse(globalLast) - ENDED_GRACE_DAYS * MS_DAY).toISOString().slice(0, 10);
  const buyRate = computeEffectiveBuyPrice(1) - 1;
  const kClose = kospi.map((p) => p.closePrice), kDates = kospi.map((p) => p.tradeDate);
  const kMa = computeSMA(kClose, KOSPI_MA_DAYS);
  const riskOff = (t: string): boolean => {
    const j = lastOnOrBefore(kDates, t);
    const ma = j >= 0 ? kMa[j] : undefined;
    return ma === undefined || kClose[j] < ma;
  };
  const rebal = new Set<string>();
  for (let k = 0; k + 1 < cal.length; k++) if (cal[k].slice(0, 7) !== cal[k + 1].slice(0, 7) && cal[k] >= PERIOD_START) rebal.add(cal[k]);
  const calIdx = new Map(cal.map((d, i) => [d, i]));

  let cash = 1;
  let prevV = 1;
  const pos = new Map<string, { val: number; last: number }>();
  const out: SimOut = { dates: [], ret: [], hold: [], cashShare: [], turn: [], orders: [] };
  for (const d of cal) {
    if (d < PERIOD_START) continue;
    const sellRate = 1 - computeEffectiveSellPrice(1, d, "KR");
    let liqOrders = 0;
    for (const [code, p] of [...pos.entries()]) {
      const sk = byCode.get(code)!;
      const i = sk.idx.get(d);
      if (i !== undefined) { p.val *= sk.close[i] / p.last; p.last = sk.close[i]; }
      else if (sk.dates[sk.dates.length - 1] < d && sk.dates[sk.dates.length - 1] < endedBefore) {
        cash += p.val * (1 - sellRate); pos.delete(code); liqOrders++;
      }
    }
    if (liqOrders) out.orders.push({ d, n: liqOrders });
    if (rebal.has(d)) {
      const V = cash + [...pos.values()].reduce((a, p) => a + p.val, 0);
      const sel = kind === "C" && riskOff(d) ? [] : selectStocks(kind === "C" ? "A" : kind, stocks, cal, calIdx.get(d)!);
      const selSet = new Set(sel);
      const T = V / N_HOLD;
      let buyN = 0, sellN = 0, n = 0;
      for (const [code, p] of pos) if (!selSet.has(code)) { sellN += p.val; n++; }
      for (const code of sel) {
        const diff = T - (pos.get(code)?.val ?? 0);
        if (diff > 0) buyN += diff; else sellN += -diff;
        if (diff !== 0) n++;
      }
      const C = buyN * buyRate + sellN * sellRate;
      const per = (V - C) / N_HOLD;
      pos.clear();
      for (const code of sel) { const sk = byCode.get(code)!; pos.set(code, { val: per, last: sk.close[sk.idx.get(d)!] }); }
      cash = V - C - per * sel.length;
      out.turn.push({ d, v: V > 0 ? (buyN + sellN) / 2 / V : 0 });
      out.orders.push({ d, n });
    }
    const V = cash + [...pos.values()].reduce((a, p) => a + p.val, 0);
    out.dates.push(d); out.ret.push((V / prevV - 1) * 100); out.hold.push(pos.size); out.cashShare.push(V > 0 ? cash / V : 1);
    prevV = V;
  }
  return out;
}

// ---- 기준선(v3 무제한) 집계: 기존 하네스와 동일 ----
interface Book { sum: Map<string, number>; cnt: Map<string, number>; trades: TR[] }
function addTrade(b: Book, t: TR): void {
  b.trades.push(t);
  for (const { d, r } of t.days) { b.sum.set(d, (b.sum.get(d) ?? 0) + r); b.cnt.set(d, (b.cnt.get(d) ?? 0) + 1); }
}
const endCap = (e: string): string => (e > TODAY ? TODAY : e);
function bookDaily(b: Book, days: string[]): number[] {
  return days.map((d) => { const s = b.sum.get(d) ?? 0, c = b.cnt.get(d) ?? 0; return c === 0 ? 0 : (s / c) * 100; });
}
function seriesMetrics(dates: string[], rets: number[], start: string, end: string): { cagr: number; mdd: number } {
  const r = rets.filter((_, i) => dates[i] >= start && dates[i] <= end);
  const { totalReturnPct, mddPct } = computeCumulativeAndMdd(r);
  return { cagr: computeCagrPct(totalReturnPct, start, endCap(end)), mdd: mddPct };
}
const seriesYear = (dates: string[], rets: number[], y: number): number =>
  computeCumulativeAndMdd(rets.filter((_, i) => dates[i].startsWith(`${y}-`))).totalReturnPct;

const f2 = (x: number): string => x.toFixed(2);
const SLICES: [string, string, string][] = [["전체 2010~", PERIOD_START, TODAY], ["학습 2010~2018", PERIOD_START, LEARN_END], ["확인 2019~", CONFIRM_START, TODAY]];
const NAMES: Record<Kind, string> = { A: "S-A 상대 모멘텀", B: "S-B 저변동성", C: "S-C 모멘텀+지수필터" };

function sliceStats(o: SimOut, s: string, e: string) {
  const m = seriesMetrics(o.dates, o.ret, s, e);
  const idxs = o.dates.map((d, i) => (d >= s && d <= e ? i : -1)).filter((i) => i >= 0);
  const years = Math.max(dayDiff(s, endCap(e)) / 365.25, 1e-9);
  const avg = (v: number[]): number => (idxs.length ? idxs.reduce((a, i) => a + v[i], 0) / idxs.length : 0);
  return {
    ...m,
    turnover: (o.turn.filter((x) => x.d >= s && x.d <= e).reduce((a, x) => a + x.v, 0) / years) * 100,
    hold: avg(o.hold), cash: avg(o.cashShare) * 100,
    trades: o.orders.filter((x) => x.d >= s && x.d <= e).reduce((a, x) => a + x.n, 0),
  };
}

export interface StudyInput { series: Map<string, StockDailyPriceRow[]>; kospi: PricePoint[]; reproGate: boolean }

export async function runStudy(inp: StudyInput): Promise<{ ok: boolean }> {
  const { series, kospi } = inp;
  const calSet = new Set<string>();
  for (const rows of series.values()) for (const r of rows) calSet.add(r.tradeDate);
  const cal = [...calSet].sort();
  const calFrom = cal.filter((d) => d >= PERIOD_START);
  const rebalanceDates = computeMonthlyRebalanceDates(calFrom);
  console.log(`거래일 캘린더 ${cal.length}일 ${cal[0]}~${cal[cal.length - 1]} (2010~ ${calFrom.length}일)`);

  const all: TR[] = [];
  const stocks: Sk[] = [];
  const pricesByStock = new Map<string, { date: string; close: number }[]>();
  const liquidity = new Map<string, Map<string, number>>();
  for (const [code, rows] of series) {
    const ctx = buildCtx(code, rows);
    series.delete(code);
    stocks.push({
      code, dates: ctx.prices.map((p) => p.date), close: Float64Array.from(ctx.closes),
      mcap: Float64Array.from(rows.map((r) => r.marketCapEok)), avgTv: ctx.avgTv, idx: new Map(ctx.prices.map((p, i) => [p.date, i])),
    });
    pricesByStock.set(code, ctx.prices.map((p) => ({ date: p.date, close: p.close })));
    const lq = new Map<string, number>();
    const idx = stocks[stocks.length - 1].idx;
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
  stocks.sort((a, b) => (a.code < b.code ? -1 : 1));

  // ---- 0) v3 재현 ----
  const base = { sum: new Map(), cnt: new Map(), trades: [] } as Book;
  for (const t of all) addTrade(base, t);
  const bDaily = bookDaily(base, calFrom);
  const b0 = seriesMetrics(calFrom, bDaily, PERIOD_START, TODAY);
  const nTr = base.trades.filter((x) => x.buyDate >= PERIOD_START).length;
  console.log(`\n=== 0) 상한 없는 v3 재현 확인 ===`);
  console.log(`하네스: CAGR ${f2(b0.cagr)}% | MDD ${f2(b0.mdd)}% | 거래 ${nTr}건`);
  console.log(`사전 등록 기준: CAGR ${EXPECT.cagr}% | MDD ${EXPECT.mdd}% | 거래 ${EXPECT.trades}건`);
  const match = f2(b0.cagr) === EXPECT.cagr && f2(b0.mdd) === EXPECT.mdd && nTr === EXPECT.trades;
  console.log(`재현 결과: ${match ? "일치" : "불일치"}`);
  if (inp.reproGate && !match) {
    console.log("재현이 어긋나 전략 실행을 하지 않고 중단합니다. (원인 후보: 데이터 범위(연도 파일)·조정계수 적용 차이, 집계 구현 차이)");
    return { ok: false };
  }

  // ---- 비교 대상 ----
  const kDates = kospi.filter((p) => p.tradeDate >= PERIOD_START).slice(1).map((p) => p.tradeDate);
  const kRets = computeIndexDailyReturnsPct(kospi.filter((p) => p.tradeDate >= PERIOD_START) as never);
  const uRets = simulateUniverseMonthlyRebalance(
    pricesByStock, calFrom, PERIOD_START,
    (code, date) => (liquidity.get(code)?.get(date) ?? NaN) >= PIT_MIN_AVG_TRADING_VALUE_WON, true
  );
  const years: number[] = [];
  for (let y = 2010; y <= Number(TODAY.slice(0, 4)); y++) years.push(y);

  const kinds: Kind[] = ["A", "B", "C"];
  const sims = new Map<Kind, SimOut>();
  for (const k of kinds) sims.set(k, simulate(k, stocks, cal, kospi));

  console.log(`\n=== 1) 구간별 요약 (회전율 = 연환산 평균 편도 %, 현금 = 일평균 %) ===`);
  for (const [lab, s, e] of SLICES) {
    console.log(`\n[${lab}]`);
    console.log("| 구성 | CAGR % | MDD % | 연환산 회전율 % | 평균 보유 종목 | 평균 현금 % | 거래 수 |");
    console.log("|---|---|---|---|---|---|---|");
    for (const k of kinds) {
      const x = sliceStats(sims.get(k)!, s, e);
      console.log(`| ${NAMES[k]} | ${f2(x.cagr)} | ${f2(x.mdd)} | ${f2(x.turnover)} | ${x.hold.toFixed(1)} | ${f2(x.cash)} | ${x.trades} |`);
    }
    const v = seriesMetrics(calFrom, bDaily, s, e);
    const days = calFrom.filter((d) => d >= s && d <= e);
    const vHold = days.reduce((a, d) => a + (base.cnt.get(d) ?? 0), 0) / Math.max(days.length, 1);
    console.log(`| 상한 없는 v3 | ${f2(v.cagr)} | ${f2(v.mdd)} | - | ${vHold.toFixed(1)} | - | ${base.trades.filter((t) => t.buyDate >= s && t.buyDate <= e).length} |`);
    const kk = seriesMetrics(kDates, kRets, s, e), uu = seriesMetrics(calFrom, uRets, s, e);
    console.log(`| KOSPI(가격지수) | ${f2(kk.cagr)} | ${f2(kk.mdd)} | - | - | - | - |`);
    console.log(`| 유니버스 동일가중 월리밸 | ${f2(uu.cagr)} | ${f2(uu.mdd)} | - | - | - | - |`);
  }

  console.log(`\n=== 2) 연도별 수익률 % ===`);
  console.log("| 구성 | " + years.join(" | ") + " |");
  console.log("|---|" + years.map(() => "---").join("|") + "|");
  const row = (name: string, f: (y: number) => number): void => console.log(`| ${name} | ${years.map((y) => f2(f(y))).join(" | ")} |`);
  for (const k of kinds) row(NAMES[k], (y) => seriesYear(sims.get(k)!.dates, sims.get(k)!.ret, y));
  row("상한 없는 v3", (y) => seriesYear(calFrom, bDaily, y));
  row("KOSPI", (y) => seriesYear(kDates, kRets, y));
  row("유니버스 동일가중", (y) => seriesYear(calFrom, uRets, y));

  console.log(`\n=== 3) 사전 통과 기준 (전체 CAGR >= ${PASS.fullCagr}, 전체 MDD <= ${PASS.fullMdd}, 학습 CAGR >= ${PASS.trainCagr} 그리고 확인 CAGR >= ${PASS.confirmCagr}) ===`);
  console.log("| 전략 | 전체 CAGR | (1) | 전체 MDD | (2) | 학습 CAGR | 확인 CAGR | (3) | 통과 |");
  console.log("|---|---|---|---|---|---|---|---|---|");
  const passers: { k: Kind; train: number }[] = [];
  for (const k of kinds) {
    const o = sims.get(k)!;
    const full = sliceStats(o, PERIOD_START, TODAY), tr = sliceStats(o, PERIOD_START, LEARN_END), cf = sliceStats(o, CONFIRM_START, TODAY);
    const c1 = full.cagr >= PASS.fullCagr, c2 = full.mdd <= PASS.fullMdd, c3 = tr.cagr >= PASS.trainCagr && cf.cagr >= PASS.confirmCagr;
    if (c1 && c2 && c3) passers.push({ k, train: tr.cagr });
    const ox = (b: boolean): string => (b ? "O" : "X");
    console.log(`| ${NAMES[k]} | ${f2(full.cagr)} | ${ox(c1)} | ${f2(full.mdd)} | ${ox(c2)} | ${f2(tr.cagr)} | ${f2(cf.cagr)} | ${ox(c3)} | ${ox(c1 && c2 && c3)} |`);
  }
  passers.sort((a, b) => b.train - a.train);
  console.log(`통과 전략: ${passers.length ? passers.map((p) => NAMES[p.k]).join(", ") : "없음"}`);
  if (passers.length >= 2) console.log(`후보 규칙(학습 CAGR 큰 쪽) 적용: ${NAMES[passers[0].k]}`);

  console.log(`\n누적 시도 횟수: ${PRIOR_ATTEMPTS} + ${kinds.length} = ${PRIOR_ATTEMPTS + kinds.length}회`);
  console.log("완료");
  return { ok: true };
}

async function main(): Promise<void> {
  console.log(`새 전략 3종 월간 리밸런싱 연구 시작(in-sample): ${new Date().toISOString()}`);
  const series = await loadSeries();
  const kospi = await getIndexPriceSeries("KOSPI", "2008-01-01", TODAY);
  const { ok } = await runStudy({ series, kospi, reproGate: true });
  if (!ok) process.exit(2);
}
if (process.argv[1] && process.argv[1].endsWith("research-new-strategies.ts")) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
