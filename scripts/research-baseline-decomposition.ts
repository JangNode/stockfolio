/**
 * [임시 진단 — 병합 금지, 읽기 전용] 기준선 분해 진단: D1~D5(시총 기반 포트폴리오) + 기준선(KOSPI/유니버스/v3/S-A/S-B/S-C).
 * 사전 등록: research/baseline-decomposition-prereg.md. 판정·추천 없이 숫자만 출력한다.
 */
import { getIndexPriceSeries } from "@/lib/betaPriceHistoryStorage";
import { PIT_MIN_AVG_TRADING_VALUE_WON } from "@/lib/strategyBacktestSummaryConfig";
import { accumulateStockDailyReturns, computeCumulativeAndMdd, computeCagrPct, type DailyStockReturns } from "@/lib/strategyBacktestSummary";
import { computeIndexDailyReturnsPct, simulateUniverseMonthlyRebalance, computeMonthlyRebalanceDates } from "@/lib/benchmarkSummary";
import { computeEffectiveBuyPrice, computeEffectiveSellPrice } from "@/lib/transactionCost";
import { computeSMA } from "@/lib/sma";
import type { StockDailyPriceRow } from "@/lib/stockDailyPricesStorage";
import { buildCtx, genTrades, loadSeries, PERIOD_START, LEARN_END, CONFIRM_START, TODAY, CAP_EOK, type Ctx } from "./research-ma-lab";

// ---- 사전 등록 상수 (research/baseline-decomposition-prereg.md, research/new-strategies-prereg.md) ----
const N_HOLD = 20; // S-A/B/C 종목 수
const TOP_SMALL = 20; // D1, D2
const TOP_LARGE = 50; // D3
const EXCLUDE_TOP = 10; // D5에서 뺄 상위 종목 수
const MOM_SKIP_DAYS = 21;
const MOM_LOOKBACK_DAYS = 252;
const VOL_WINDOW_DAYS = 252;
const VOL_MIN_ROWS = 200;
const KOSPI_MA_DAYS = 200;
const PRICE_ASOF_MAX_GAP_DAYS = 10;
const ENDED_GRACE_DAYS = 14;
const NEAR_HIGH_MIN_GAP = -0.1829;
const NEAR_HIGH_BARS = 252;
const FAIR_START = "2011-01-01";
const EXPECT = { cagr: "6.36", mdd: "53.31", trades: 2335 };
const PRIOR_SA: Record<string, string> = { A: "-1.17 / 81.39", B: "1.58 / 52.79", C: "1.69 / 66.15" }; // 직전 실행 2010~ 전체
const MS_DAY = 86_400_000;

interface PricePoint { tradeDate: string; closePrice: number }
interface Sk { code: string; dates: string[]; close: Float64Array; mcap: Float64Array; avgTv: Float64Array; idx: Map<string, number> }
interface TR { buyDate: string; sellDate: string; ret: number; days: { d: string; r: number }[] }
type Kind = "A" | "B" | "C" | "D1" | "D2" | "D3" | "D4" | "D5";
interface Tgt { code: string; w: number }

function nearHighOk(ctx: Ctx, e: number): boolean {
  let hi = -Infinity;
  for (let j = Math.max(0, e - (NEAR_HIGH_BARS - 1)); j <= e; j++) if (ctx.prices[j].high > hi) hi = ctx.prices[j].high;
  return ctx.prices[e].close / hi - 1 > NEAR_HIGH_MIN_GAP;
}
const dayDiff = (a: string, b: string): number => (Date.parse(b) - Date.parse(a)) / MS_DAY;
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
const byCodeAsc = (a: { code: string }, b: { code: string }): number => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);

/** 적격 종목(t일 행 있음, 직전 행 시총 >= 5천억, 직전 20거래일 평균 거래대금 >= 5억) + t일 시총. */
function eligible(stocks: Sk[], t: string): { sk: Sk; i: number; mcap: number }[] {
  const out: { sk: Sk; i: number; mcap: number }[] = [];
  for (const sk of stocks) {
    const i = sk.idx.get(t);
    if (i === undefined || i < 1) continue;
    if (!(sk.mcap[i - 1] >= CAP_EOK) || !(sk.avgTv[i] >= PIT_MIN_AVG_TRADING_VALUE_WON)) continue;
    out.push({ sk, i, mcap: sk.mcap[i] });
  }
  return out;
}

function targets(kind: Kind, stocks: Sk[], cal: string[], k: number): Tgt[] {
  const t = cal[k];
  const el = eligible(stocks, t);
  if (kind.startsWith("D")) {
    const sorted = [...el].sort((a, b) => b.mcap - a.mcap || byCodeAsc(a.sk, b.sk));
    const ew = (arr: typeof el): Tgt[] => arr.map((x) => ({ code: x.sk.code, w: 1 / arr.length }));
    const mw = (arr: typeof el): Tgt[] => { const s = arr.reduce((a, x) => a + x.mcap, 0); return arr.map((x) => ({ code: x.sk.code, w: x.mcap / s })); };
    if (kind === "D1") return ew(sorted.slice(0, TOP_SMALL));
    if (kind === "D2") return mw(sorted.slice(0, TOP_SMALL));
    if (kind === "D3") return ew(sorted.slice(0, TOP_LARGE));
    if (kind === "D4") return mw(sorted);
    return ew(sorted.slice(EXCLUDE_TOP));
  }
  if (k < MOM_LOOKBACK_DAYS) return [];
  const cand: { code: string; score: number }[] = [];
  for (const { sk, i } of el) {
    if (kind !== "B") {
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
  cand.sort((a, b) => (kind === "B" ? a.score - b.score : b.score - a.score) || byCodeAsc(a, b));
  return cand.slice(0, N_HOLD).map((c) => ({ code: c.code, w: 1 / N_HOLD }));
}

interface SimOut { dates: string[]; ret: number[]; hold: number[]; cashShare: number[]; turn: { d: string; v: number }[]; orders: { d: string; n: number }[] }

function simulate(kind: Kind, stocks: Sk[], cal: string[], kospi: PricePoint[]): SimOut {
  const byCode = new Map(stocks.map((s) => [s.code, s]));
  const endedBefore = new Date(Date.parse(cal[cal.length - 1]) - ENDED_GRACE_DAYS * MS_DAY).toISOString().slice(0, 10);
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

  let cash = 1, prevV = 1;
  const pos = new Map<string, { val: number; last: number }>();
  const out: SimOut = { dates: [], ret: [], hold: [], cashShare: [], turn: [], orders: [] };
  for (const d of cal) {
    if (d < PERIOD_START) continue;
    const sellRate = 1 - computeEffectiveSellPrice(1, d, "KR");
    let liq = 0;
    for (const [code, p] of [...pos.entries()]) {
      const sk = byCode.get(code)!;
      const i = sk.idx.get(d);
      if (i !== undefined) { p.val *= sk.close[i] / p.last; p.last = sk.close[i]; }
      else if (sk.dates[sk.dates.length - 1] < d && sk.dates[sk.dates.length - 1] < endedBefore) { cash += p.val * (1 - sellRate); pos.delete(code); liq++; }
    }
    if (liq) out.orders.push({ d, n: liq });
    if (rebal.has(d)) {
      const V = cash + [...pos.values()].reduce((a, p) => a + p.val, 0);
      const tg = kind === "C" && riskOff(d) ? [] : targets(kind === "C" ? "A" : kind, stocks, cal, calIdx.get(d)!);
      const tgMap = new Map(tg.map((x) => [x.code, x.w]));
      let buyN = 0, sellN = 0, n = 0;
      for (const [code, p] of pos) if (!tgMap.has(code)) { sellN += p.val; n++; }
      for (const { code, w } of tg) {
        const diff = w * V - (pos.get(code)?.val ?? 0);
        if (diff > 0) buyN += diff; else sellN += -diff;
        if (diff !== 0) n++;
      }
      const C = buyN * buyRate + sellN * sellRate;
      const scale = (V - C) / V;
      pos.clear();
      let invested = 0;
      for (const { code, w } of tg) { const sk = byCode.get(code)!; const val = w * V * scale; pos.set(code, { val, last: sk.close[sk.idx.get(d)!] }); invested += val; }
      cash = V - C - invested;
      out.turn.push({ d, v: V > 0 ? (buyN + sellN) / 2 / V : 0 });
      out.orders.push({ d, n });
    }
    const V = cash + [...pos.values()].reduce((a, p) => a + p.val, 0);
    out.dates.push(d); out.ret.push((V / prevV - 1) * 100); out.hold.push(pos.size); out.cashShare.push(V > 0 ? cash / V : 1);
    prevV = V;
  }
  return out;
}

interface Book { sum: Map<string, number>; cnt: Map<string, number>; trades: TR[] }
function addTrade(b: Book, t: TR): void {
  b.trades.push(t);
  for (const { d, r } of t.days) { b.sum.set(d, (b.sum.get(d) ?? 0) + r); b.cnt.set(d, (b.cnt.get(d) ?? 0) + 1); }
}
const endCap = (e: string): string => (e > TODAY ? TODAY : e);
function seriesMetrics(dates: string[], rets: number[], start: string, end: string): { cagr: number; mdd: number } {
  const r = rets.filter((_, i) => dates[i] >= start && dates[i] <= end);
  const { totalReturnPct, mddPct } = computeCumulativeAndMdd(r);
  return { cagr: computeCagrPct(totalReturnPct, start, endCap(end)), mdd: mddPct };
}
const seriesYear = (dates: string[], rets: number[], y: number): number =>
  computeCumulativeAndMdd(rets.filter((_, i) => dates[i].startsWith(`${y}-`))).totalReturnPct;
const f2 = (x: number): string => x.toFixed(2);
const mean = (v: number[]): number => (v.length ? v.reduce((a, x) => a + x, 0) / v.length : NaN);

const NAMES: Record<Kind, string> = {
  A: "S-A 상대 모멘텀", B: "S-B 저변동성", C: "S-C 모멘텀+지수필터",
  D1: "D1 상위20 동일가중", D2: "D2 상위20 시총가중", D3: "D3 상위50 동일가중", D4: "D4 전체 시총가중", D5: "D5 상위10 제외 동일가중",
};
const KINDS: Kind[] = ["D1", "D2", "D3", "D4", "D5", "A", "B", "C"];

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
  console.log(`거래일 캘린더 ${cal.length}일 ${cal[0]}~${cal[cal.length - 1]}`);

  const all: TR[] = [];
  const stocks: Sk[] = [];
  const pricesByStock = new Map<string, { date: string; close: number }[]>();
  const liquidity = new Map<string, Map<string, number>>();
  for (const [code, rows] of series) {
    const ctx = buildCtx(code, rows);
    series.delete(code);
    const sk: Sk = { code, dates: ctx.prices.map((p) => p.date), close: Float64Array.from(ctx.closes), mcap: Float64Array.from(rows.map((r) => r.marketCapEok)), avgTv: ctx.avgTv, idx: new Map(ctx.prices.map((p, i) => [p.date, i])) };
    stocks.push(sk);
    pricesByStock.set(code, ctx.prices.map((p) => ({ date: p.date, close: p.close })));
    const lq = new Map<string, number>();
    for (const d of rebalanceDates) {
      const i = sk.idx.get(d);
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
  stocks.sort(byCodeAsc);

  // ---- 0) v3 재현 ----
  const base: Book = { sum: new Map(), cnt: new Map(), trades: [] };
  for (const t of all) addTrade(base, t);
  const bDaily = calFrom.map((d) => { const c = base.cnt.get(d) ?? 0; return c === 0 ? 0 : ((base.sum.get(d) ?? 0) / c) * 100; });
  const b0 = seriesMetrics(calFrom, bDaily, PERIOD_START, TODAY);
  const nTr = base.trades.filter((x) => x.buyDate >= PERIOD_START).length;
  console.log(`\n=== 0) 상한 없는 v3 재현 확인 ===`);
  console.log(`하네스: CAGR ${f2(b0.cagr)}% | MDD ${f2(b0.mdd)}% | 거래 ${nTr}건`);
  console.log(`사전 등록 기준: CAGR ${EXPECT.cagr}% | MDD ${EXPECT.mdd}% | 거래 ${EXPECT.trades}건`);
  const match = f2(b0.cagr) === EXPECT.cagr && f2(b0.mdd) === EXPECT.mdd && nTr === EXPECT.trades;
  console.log(`재현 결과: ${match ? "일치" : "불일치"}`);
  if (inp.reproGate && !match) {
    console.log("재현이 어긋나 실행을 중단합니다. (원인 후보: 데이터 범위·조정계수 적용 차이, 집계 구현 차이)");
    return { ok: false };
  }

  const kp = kospi.filter((p) => p.tradeDate >= PERIOD_START);
  const kDates = kp.slice(1).map((p) => p.tradeDate);
  const kRets = computeIndexDailyReturnsPct(kp as never);
  const uRets = simulateUniverseMonthlyRebalance(
    pricesByStock, calFrom, PERIOD_START,
    (code, date) => (liquidity.get(code)?.get(date) ?? NaN) >= PIT_MIN_AVG_TRADING_VALUE_WON, true
  );
  const years: number[] = [];
  for (let y = 2010; y <= Number(TODAY.slice(0, 4)); y++) years.push(y);

  const sims = new Map<Kind, SimOut>();
  for (const k of KINDS) sims.set(k, simulate(k, stocks, cal, kospi));

  console.log(`\n=== 일관성 점검: S-A/B/C 2010~ 전체 (CAGR / MDD) vs 직전 실행 ===`);
  for (const k of ["A", "B", "C"] as Kind[]) {
    const x = sliceStats(sims.get(k)!, PERIOD_START, TODAY);
    const got = `${f2(x.cagr)} / ${f2(x.mdd)}`;
    console.log(`${NAMES[k]}: ${got} | 직전 ${PRIOR_SA[k]} | ${got === PRIOR_SA[k] ? "일치" : "불일치"}`);
  }

  const ranges: [string, string][] = [["2010~", PERIOD_START], ["2011~", FAIR_START]];
  for (const [rl, rs] of ranges) {
    const sl: [string, string, string][] = [[`전체 ${rl}`, rs, TODAY], [`학습 ${rs.slice(0, 4)}~2018`, rs, LEARN_END], ["확인 2019~", CONFIRM_START, TODAY]];
    console.log(`\n=== 1) 구간 ${rl} 요약 (회전율 = 연환산 편도 %, 현금 = 일평균 %) ===`);
    for (const [lab, s, e] of sl) {
      console.log(`\n[${lab}]`);
      console.log("| 구성 | CAGR % | MDD % | 연환산 회전율 % | 평균 보유 종목 | 평균 현금 % | 거래 수 |");
      console.log("|---|---|---|---|---|---|---|");
      for (const k of KINDS) {
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
  }

  console.log(`\n=== 2) 연도별 수익률 % ===`);
  console.log("| 구성 | " + years.join(" | ") + " |");
  console.log("|---|" + years.map(() => "---").join("|") + "|");
  const row = (name: string, f: (y: number) => number): void => console.log(`| ${name} | ${years.map((y) => f2(f(y))).join(" | ")} |`);
  for (const k of KINDS) row(NAMES[k], (y) => seriesYear(sims.get(k)!.dates, sims.get(k)!.ret, y));
  row("상한 없는 v3", (y) => seriesYear(calFrom, bDaily, y));
  row("KOSPI", (y) => seriesYear(kDates, kRets, y));
  row("유니버스 동일가중", (y) => seriesYear(calFrom, uRets, y));

  console.log(`\n=== 3-1) 월말 유니버스 시총 상위 10 비중(상위 10 시총 합 ÷ 유니버스 시총 합), 연도별 평균 ===`);
  const shareByYear = new Map<number, number[]>();
  const sizeByYear = new Map<number, number[]>();
  const calIdx = new Map(cal.map((d, i) => [d, i]));
  const rebalDays = calFrom.filter((d, i) => i + 1 < calFrom.length && d.slice(0, 7) !== calFrom[i + 1].slice(0, 7));
  for (const d of rebalDays) {
    void calIdx;
    const el = eligible(stocks, d).map((x) => x.mcap).sort((a, b) => b - a);
    if (!el.length) continue;
    const tot = el.reduce((a, x) => a + x, 0);
    const top = el.slice(0, 10).reduce((a, x) => a + x, 0);
    const y = Number(d.slice(0, 4));
    (shareByYear.get(y) ?? shareByYear.set(y, []).get(y)!).push(top / tot);
    (sizeByYear.get(y) ?? sizeByYear.set(y, []).get(y)!).push(el.length);
  }
  console.log("| 연도 | 상위 10 비중 % | 월말 유니버스 종목 수(평균) | 리밸런싱일 수 |");
  console.log("|---|---|---|---|");
  for (const y of years) if (shareByYear.has(y)) console.log(`| ${y} | ${f2(mean(shareByYear.get(y)!) * 100)} | ${mean(sizeByYear.get(y)!).toFixed(1)} | ${shareByYear.get(y)!.length} |`);

  console.log(`\n=== 3-2) D1 vs KOSPI 연도별 ===`);
  console.log("| 연도 | D1 % | KOSPI % | 차이 %p | 결과 |");
  console.log("|---|---|---|---|---|");
  let win = 0, lose = 0;
  const d1 = sims.get("D1")!;
  for (const y of years) {
    const a = seriesYear(d1.dates, d1.ret, y), b = seriesYear(kDates, kRets, y);
    const w = a > b;
    if (w) win++; else lose++;
    console.log(`| ${y} | ${f2(a)} | ${f2(b)} | ${f2(a - b)} | ${w ? "이김" : "짐"} |`);
  }
  console.log(`D1 이긴 해 ${win} / 진 해 ${lose} (2010~${years[years.length - 1]}, 마지막 해는 부분 연도)`);
  console.log("\n진단(시도 횟수에 포함하지 않음, 누적 54회 유지)\n완료");
  return { ok: true };
}

async function main(): Promise<void> {
  console.log(`기준선 분해 진단 시작(in-sample): ${new Date().toISOString()}`);
  const series = await loadSeries();
  const kospi = await getIndexPriceSeries("KOSPI", "2008-01-01", TODAY);
  const { ok } = await runStudy({ series, kospi, reproGate: true });
  if (!ok) process.exit(2);
}
if (process.argv[1] && process.argv[1].endsWith("research-baseline-decomposition.ts")) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
