/**
 * [임시 진단 — 병합 금지, 읽기 전용, 외부 요청 0건, 새 시도 아님] W2 peg 수치 불일치 원인 진단.
 * 정의: research/peg-extended-diagnose-prereg.md. peg 규칙은 scripts/research-peg-extended.ts(edb53b6)와 같다(재무 로더 조합만 변형).
 */
import { getIndexPriceSeries } from "@/lib/betaPriceHistoryStorage";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { DEFAULT_ON_OR_BEFORE_LOOKBACK_DAYS, loadAllStockSeriesFromParquet } from "@/lib/stockDailyPricesStorage";
import { loadAppliedAdjustments } from "@/lib/stockPriceAdjustmentsStorage";
import { pickFundamentalsAsOf, computeValuationFromSeries, type FundamentalsSeries, type StockFundamentalsAsOf } from "@/lib/pointInTimeFundamentals";
import { selectEpsCagrFiscalYears, computeEpsCagrFromResolvedShares, computePeg, type ListedSharesByFiscalYear } from "@/lib/pegRatio";
import { PEG_MAX_RATIO } from "@/lib/pegConfig";
import { runBacktest, type DailyPrice, type StrategyRule } from "@/lib/backtest";
import { pickListedSharesOnOrBefore, computeTrailingAvgTradingValue } from "@/lib/pitUniverse";
import { PIT_MIN_AVG_TRADING_VALUE_WON, PIT_LIQUIDITY_LOOKBACK_DAYS } from "@/lib/strategyBacktestSummaryConfig";
import { accumulateStockDailyReturns, computeCumulativeAndMdd, computeCagrPct, type DailyStockReturns } from "@/lib/strategyBacktestSummary";
import { buildCtx, PERIOD_START, TODAY, CAP_EOK } from "./research-ma-lab";

void getIndexPriceSeries;
const T0 = Date.now();
const PEG_RULE: StrategyRule = { rule_type: "peg_lynch", rule_params: {} };
const WSTART = "2021-03-01";
const ENDED_GRACE_DAYS = 14;
const MS_DAY = 86_400_000;
const DB_CHUNK = 100;
const PRIOR_2021_PCT = 58;
const f2 = (x: number): string => (Number.isFinite(x) ? x.toFixed(2) : "-");
const mean = (v: number[]): number => (v.length ? v.reduce((a, x) => a + x, 0) / v.length : NaN);
const dbRead: Record<string, number> = {};
async function selectAll<T>(label: string, build: (f: number, t: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from, from + 999);
    if (error) throw new Error(`${label}: ${error.message}`);
    out.push(...(data ?? []));
    dbRead[label] = (dbRead[label] ?? 0) + (data?.length ?? 0);
    if ((data?.length ?? 0) < 1000) break;
  }
  return out;
}

type Src = "stock" | "fill" | "xbrl";
interface FRow { fy: number; rceptNo: string; rcept: string; ni: number | null; eq: number | null; fsDiv: "CFS" | "OFS"; src: Src }
function toSeries(rows: FRow[]): FundamentalsSeries {
  const sorted = [...rows].sort((a, b) => (a.rcept === b.rcept ? a.fy - b.fy : a.rcept < b.rcept ? -1 : 1));
  const annual: StockFundamentalsAsOf[] = sorted.map((r) => ({ fiscalYear: r.fy, rceptNo: r.rceptNo, rceptDate: r.rcept, netIncomeParent: r.ni, equityParent: r.eq, fsDiv: r.fsDiv }));
  return { annual, dividends: [] };
}
const listedSharesOf = (series: FundamentalsSeries, lsFn: (d: string) => number | null): ListedSharesByFiscalYear => new Map(series.annual.map((a) => [a.fiscalYear, lsFn(a.rceptDate)] as const));
function pegStates(prices: DailyPrice[], f: FundamentalsSeries, ls: ListedSharesByFiscalYear): (boolean | undefined)[] {
  return prices.map((p) => {
    if (p.listedShares === undefined) return undefined;
    const fund = pickFundamentalsAsOf(f, p.date);
    if (!fund) return undefined;
    if (fund.netIncomeParent === null) return undefined;
    if (fund.netIncomeParent <= 0) return false;
    const { per } = computeValuationFromSeries(p.close, p.listedShares, fund);
    const pair = selectEpsCagrFiscalYears(f, p.date);
    if (!pair) return undefined;
    const peg = computePeg(per, computeEpsCagrFromResolvedShares(pair, ls));
    if (peg === null) return false;
    return peg <= PEG_MAX_RATIO;
  });
}

interface TB { code: string; buyDate: string; sellDate: string; ret: number; forced: boolean; delisted: boolean; days: { d: string; r: number }[] }
interface VB { trades: TB[]; sum: Map<string, number>; cnt: Map<string, number>; byDay: Map<string, Map<string, number>> }
const newVB = (): VB => ({ trades: [], sum: new Map(), cnt: new Map(), byDay: new Map() });
function addTB(b: VB, t: TB): void {
  b.trades.push(t);
  for (const { d, r } of t.days) {
    b.sum.set(d, (b.sum.get(d) ?? 0) + r); b.cnt.set(d, (b.cnt.get(d) ?? 0) + 1);
    const m = b.byDay.get(d) ?? b.byDay.set(d, new Map()).get(d)!;
    m.set(t.code, (m.get(t.code) ?? 0) + r);
  }
}
let CAL: string[] = [];
const dailyOf = (b: VB): number[] => CAL.map((d) => { const c = b.cnt.get(d) ?? 0; return c === 0 ? 0 : ((b.sum.get(d) ?? 0) / c) * 100; });
const startOf = (b: VB, from: string): string | null => { const t = b.trades.filter((x) => x.buyDate >= from); return t.length ? `${t.reduce((m, x) => (x.buyDate < m ? x.buyDate : m), "9999").slice(0, 7)}-01` : null; };
function metrics(dates: string[], rets: number[], S: string, end: string) {
  const r = rets.filter((_, i) => dates[i] >= S && dates[i] <= end);
  const { totalReturnPct, mddPct } = computeCumulativeAndMdd(r);
  return { cagr: computeCagrPct(totalReturnPct, S, end), mdd: mddPct };
}
const yret = (rets: number[], y: number, S: string): number => computeCumulativeAndMdd(rets.filter((_, i) => CAL[i].startsWith(`${y}-`) && CAL[i] >= S)).totalReturnPct;

async function main(): Promise<void> {
  console.log(`W2 peg 불일치 진단 시작(읽기 전용): ${new Date().toISOString()} (진단 정의 커밋 c06aeb2 이후)`);
  const adjustments = await loadAppliedAdjustments();
  dbRead["stock_price_adjustment_events(applied)"] = [...adjustments.values()].reduce((a, l) => a + l.length, 0);
  const series = await loadAllStockSeriesFromParquet(2010, new Date().getUTCFullYear(), adjustments);
  const calSet = new Set<string>();
  let globalLast = "";
  for (const rows of series.values()) {
    for (const r of rows) if (r.tradeDate >= PERIOD_START) calSet.add(r.tradeDate);
    if (rows.length && rows[rows.length - 1].tradeDate > globalLast) globalLast = rows[rows.length - 1].tradeDate;
  }
  CAL = [...calSet].sort();
  const monthEndSet = new Set<string>();
  for (let k = 0; k + 1 < CAL.length; k++) if (CAL[k].slice(0, 7) !== CAL[k + 1].slice(0, 7)) monthEndSet.add(CAL[k]);
  const monthEnds = [...monthEndSet].sort();
  const endedBefore = new Date(Date.parse(globalLast) - ENDED_GRACE_DAYS * MS_DAY).toISOString().slice(0, 10);
  console.log(`종목 ${series.size}개, 거래일 ${CAL.length}일 ${CAL[0]}~${CAL[CAL.length - 1]}, 종료 판정 기준일 ${endedBefore}`);

  const codes = [...series.keys()];
  const candidate: string[] = [];
  for (const code of codes) {
    const rows = series.get(code)!;
    const tv = computeTrailingAvgTradingValue(rows, PIT_LIQUIDITY_LOOKBACK_DAYS);
    for (let i = 0; i < rows.length; i++) if (rows[i].tradeDate >= "2016-03-01" && tv[i] >= PIT_MIN_AVG_TRADING_VALUE_WON && rows[i].marketCapEok >= CAP_EOK) { candidate.push(code); break; }
  }
  const rowsBy = { stock: new Map<string, FRow[]>(), fill: new Map<string, FRow[]>(), xbrl: new Map<string, FRow[]>() };
  const dropped = { fillNull: 0, xbrlNull: 0 };
  for (let i = 0; i < candidate.length; i += DB_CHUNK) {
    const chunk = candidate.slice(i, i + DB_CHUNK);
    const a = await selectAll<{ stock_code: string; fiscal_year: number; rcept_no: string; rcept_date: string; net_income_parent: number | null; equity_parent: number | null; fs_div: string }>("stock_annual_fundamentals", (f, t) => supabaseAdmin.from("stock_annual_fundamentals").select("stock_code, fiscal_year, rcept_no, rcept_date, net_income_parent, equity_parent, fs_div").in("stock_code", chunk).range(f, t));
    for (const r of a) rowsBy.stock.set(r.stock_code, [...(rowsBy.stock.get(r.stock_code) ?? []), { fy: r.fiscal_year, rceptNo: r.rcept_no, rcept: r.rcept_date, ni: r.net_income_parent === null ? null : Number(r.net_income_parent), eq: r.equity_parent === null ? null : Number(r.equity_parent), fsDiv: r.fs_div as "CFS" | "OFS", src: "stock" }]);
    const b = await selectAll<{ stock_code: string; fiscal_year: number; rcept_no: string | null; rcept_date: string | null; net_income_parent: number | null; equity_parent: number | null; fs_div: string | null }>("stock_annual_fundamentals_fill(ok)", (f, t) => supabaseAdmin.from("stock_annual_fundamentals_fill").select("stock_code, fiscal_year, rcept_no, rcept_date, net_income_parent, equity_parent, fs_div").eq("status", "ok").in("stock_code", chunk).range(f, t));
    for (const r of b) { if (!r.rcept_date || !r.rcept_no) { dropped.fillNull++; continue; } rowsBy.fill.set(r.stock_code, [...(rowsBy.fill.get(r.stock_code) ?? []), { fy: r.fiscal_year, rceptNo: r.rcept_no, rcept: r.rcept_date, ni: r.net_income_parent === null ? null : Number(r.net_income_parent), eq: r.equity_parent === null ? null : Number(r.equity_parent), fsDiv: (r.fs_div ?? "CFS") as "CFS" | "OFS", src: "fill" }]); }
    const c = await selectAll<{ stock_code: string; fiscal_year: number; rcept_no: string | null; rcept_dt: string | null; net_income_parent?: never; ni_parent: number | null; equity_parent: number | null; ni_basis: string | null }>("dart_xbrl_fundamentals", (f, t) => supabaseAdmin.from("dart_xbrl_fundamentals").select("stock_code, fiscal_year, rcept_no, rcept_dt, ni_parent, equity_parent, ni_basis").in("stock_code", chunk).range(f, t));
    for (const r of c) { if (!r.rcept_dt || !r.rcept_no) { dropped.xbrlNull++; continue; } rowsBy.xbrl.set(r.stock_code, [...(rowsBy.xbrl.get(r.stock_code) ?? []), { fy: r.fiscal_year, rceptNo: r.rcept_no, rcept: r.rcept_dt, ni: r.ni_parent === null ? null : Number(r.ni_parent), eq: r.equity_parent === null ? null : Number(r.equity_parent), fsDiv: r.ni_basis === "sep" ? "OFS" : "CFS", src: "xbrl" }]); }
  }
  const mergeRows = (code: string, fill: boolean, xbrl: boolean): Map<number, FRow> => {
    const by = new Map<number, FRow>();
    if (xbrl) for (const r of rowsBy.xbrl.get(code) ?? []) by.set(r.fy, r);
    if (fill) for (const r of rowsBy.fill.get(code) ?? []) by.set(r.fy, r);
    for (const r of rowsBy.stock.get(code) ?? []) by.set(r.fy, r);
    return by;
  };

  type V = "A" | "B" | "C" | "D" | "A2010";
  const VS: V[] = ["A", "B", "C", "D", "A2010"];
  const cfg: Record<V, { fill: boolean; xbrl: boolean; start: string }> = { A: { fill: false, xbrl: false, start: WSTART }, B: { fill: true, xbrl: false, start: WSTART }, C: { fill: false, xbrl: true, start: WSTART }, D: { fill: true, xbrl: true, start: WSTART }, A2010: { fill: false, xbrl: false, start: PERIOD_START } };
  const books = Object.fromEntries(VS.map((v) => [v, newVB()])) as Record<V, VB>;
  const sigM = new Map<string, { members: number; A: Set<string>; D: Set<string> }>();
  const sigMonths = monthEnds.filter((d) => d >= "2021-03-01" && d <= "2021-06-30");
  // 사용된 재무 행: (code|fy|src) 집합과 late 건수
  const used: Record<"A" | "D", Map<string, { src: Src; fy: number }>> = { A: new Map(), D: new Map() };
  const lateUsed = { fill: 0, xbrl: 0, stock: 0 }, usedCnt = { fill: 0, xbrl: 0, stock: 0 };
  const candSet = new Set(candidate);
  const lastDates = new Map<string, string>();
  let done = 0;
  for (const code of codes) {
    const rows = series.get(code)!;
    series.delete(code);
    lastDates.set(code, rows[rows.length - 1].tradeDate);
    if (!candSet.has(code)) continue;
    const ctx = buildCtx(code, rows);
    const prices = ctx.prices;
    const idx = new Map(prices.map((p, i) => [p.date, i]));
    const entryAllowed = (date: string): boolean => { const i = idx.get(date); return i !== undefined && ctx.avgTv[i] >= PIT_MIN_AVG_TRADING_VALUE_WON && rows[i].marketCapEok >= CAP_EOK; };
    const lsFn = (d: string): number | null => pickListedSharesOnOrBefore(rows, d, DEFAULT_ON_OR_BEFORE_LOOKBACK_DAYS);
    const lastDate = rows[rows.length - 1].tradeDate;
    const fv: Partial<Record<V, { f: FundamentalsSeries; ls: ListedSharesByFiscalYear; by: Map<number, FRow> }>> = {};
    for (const v of VS) {
      if (v === "A2010") { fv.A2010 = fv.A; continue; }
      const by = mergeRows(code, cfg[v].fill, cfg[v].xbrl);
      const f = toSeries([...by.values()]);
      fv[v] = { f, ls: listedSharesOf(f, lsFn), by };
    }
    for (const v of VS) {
      const x = fv[v]!;
      const res = runBacktest(prices, PEG_RULE, cfg[v].start, x.f, x.ls, { market: "KR", entryAllowed, includeTransactionCosts: true });
      for (const t of res.trades) {
        const tmp: DailyStockReturns = new Map();
        accumulateStockDailyReturns(tmp, new Map(), code, prices, [t], cfg[v].start, "KR", true);
        const forced = !!t.isForcedLiquidation;
        addTB(books[v], { code, buyDate: t.buyDate, sellDate: t.sellDate, ret: t.returnPct, forced, delisted: forced && lastDate < endedBefore, days: [...tmp.entries()].map(([d, es]) => ({ d, r: es[0].returnPct })) });
        if (v === "A" || v === "D") {
          const fund = pickFundamentalsAsOf(x.f, t.buyDate);
          const pair = selectEpsCagrFiscalYears(x.f, t.buyDate);
          for (const row of [fund, pair?.start, pair?.end]) {
            if (!row) continue;
            const src = x.by.get(row.fiscalYear)?.src ?? "stock";
            used[v].set(`${code}|${row.fiscalYear}|${src}`, { src, fy: row.fiscalYear });
            if (v === "D") { usedCnt[src]++; if (row.rceptDate > t.buyDate) lateUsed[src]++; }
          }
        }
      }
    }
    // 2021-03~06 월말 신호 true
    const stA = pegStates(prices, fv.A!.f, fv.A!.ls), stD = pegStates(prices, fv.D!.f, fv.D!.ls);
    for (const d of sigMonths) {
      const i = idx.get(d);
      if (i === undefined || !entryAllowed(d)) continue;
      const e = sigM.get(d) ?? sigM.set(d, { members: 0, A: new Set(), D: new Set() }).get(d)!;
      e.members++;
      if (stA[i] === true) e.A.add(code);
      if (stD[i] === true) e.D.add(code);
    }
    if (++done % 200 === 0) console.log(`  진행 ${done}/${candidate.length}, 경과 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
  }

  const end = TODAY;
  const daily = Object.fromEntries(VS.map((v) => [v, dailyOf(books[v])])) as Record<V, number[]>;
  const S = Object.fromEntries(VS.map((v) => [v, startOf(books[v], cfg[v].start) ?? cfg[v].start])) as Record<V, string>;

  // ---- 1 ----
  console.log("\n=== 1. W2 변형별 재계산 (A=stock, B=stock+fill, C=stock+xbrl, D=3표) ===");
  console.log("| 변형 | S | CAGR % | MDD % | 거래 수 | 월말 평균 보유 | 월말 최소 보유 |\n|---|---|---|---|---|---|---|");
  for (const v of ["A", "B", "C", "D"] as V[]) {
    const m = metrics(CAL, daily[v], S[v], end);
    const ms = monthEnds.filter((d) => d >= S[v] && d <= end);
    const cs = ms.map((d) => books[v].cnt.get(d) ?? 0);
    console.log(`| ${v} | ${S[v]} | ${f2(m.cagr)} | ${f2(m.mdd)} | ${books[v].trades.filter((t) => t.buyDate >= WSTART).length} | ${f2(mean(cs))} | ${Math.min(...cs)} |`);
  }
  console.log("\n연도별 수익률 % (변형별 S 이후, 2021은 부분 연도)");
  console.log("| 변형 | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 |\n|---|---|---|---|---|---|---|");
  for (const v of ["A", "B", "C", "D"] as V[]) console.log(`| ${v} | ${[2021, 2022, 2023, 2024, 2025, 2026].map((y) => f2(yret(daily[v], y, S[v]))).join(" | ")} |`);
  console.log("\n2021-03~2021-12 월별 보유 종목 수(월말) / 월 수익률 %");
  console.log("| 월 | A 보유 | A 수익 | B 보유 | B 수익 | C 보유 | C 수익 | D 보유 | D 수익 |\n|---|---|---|---|---|---|---|---|---|");
  for (let m = 3; m <= 12; m++) {
    const ym = `2021-${String(m).padStart(2, "0")}`;
    const me = monthEnds.find((d) => d.startsWith(ym))!;
    const cells = (["A", "B", "C", "D"] as V[]).map((v) => `${books[v].cnt.get(me) ?? 0} | ${f2(computeCumulativeAndMdd(daily[v].filter((_, i) => CAL[i].startsWith(ym))).totalReturnPct)}`);
    console.log(`| ${ym} | ${cells.join(" | ")} |`);
  }

  // ---- 2 ----
  console.log("\n=== 2. A와 D의 거래 차이 분해 ===");
  const TA = books.A.trades.filter((t) => t.buyDate >= WSTART), TD = books.D.trades.filter((t) => t.buyDate >= WSTART);
  const overlap = (x: TB, y: TB): boolean => x.code === y.code && x.buyDate <= y.sellDate && y.buyDate <= x.sellDate;
  const byCodeA = new Map<string, TB[]>(), byCodeD = new Map<string, TB[]>();
  for (const t of TA) byCodeA.set(t.code, [...(byCodeA.get(t.code) ?? []), t]);
  for (const t of TD) byCodeD.set(t.code, [...(byCodeD.get(t.code) ?? []), t]);
  const keyOf = (t: TB): string => `${t.code}|${t.buyDate}|${t.sellDate}`;
  const setA = new Set(TA.map(keyOf)), setD = new Set(TD.map(keyOf));
  const cls = (t: TB, other: Map<string, TB[]>, otherSet: Set<string>, onlyName: string): string =>
    otherSet.has(keyOf(t)) ? "동일" : (other.get(t.code) ?? []).some((o) => overlap(t, o)) ? "날짜 다름" : onlyName;
  const groups: { name: string; side: "A" | "D"; list: TB[] }[] = [];
  for (const [side, T, other, oset, only] of [["A", TA, byCodeD, setD, "A에만"], ["D", TD, byCodeA, setA, "D에만"]] as const) {
    for (const g of ["동일", "날짜 다름", only]) groups.push({ name: g, side, list: T.filter((t) => cls(t, other, oset, only) === g) });
  }
  const totalContrib = (b: VB, list: TB[]): number => list.reduce((s, t) => s + t.days.reduce((a, { d, r }) => a + (r / Math.max(b.cnt.get(d) ?? 1, 1)) * 100, 0), 0);
  console.log(`A 거래 ${TA.length}건, D 거래 ${TD.length}건`);
  console.log("| 기준 변형 | 그룹 | 건수 | 평균 거래 수익률 % | 기여 추정(%p, 일별 단순 합) |\n|---|---|---|---|---|");
  for (const g of groups) console.log(`| ${g.side} | ${g.name} | ${g.list.length} | ${f2(mean(g.list.map((t) => t.ret * 100)))} | ${f2(totalContrib(books[g.side], g.list))} |`);
  console.log(`기여 합계(참고, %p): A ${f2(totalContrib(books.A, TA))} | D ${f2(totalContrib(books.D, TD))}`);

  // 상위 10일 차이
  const diffDays = CAL.map((d, i) => ({ d, i, diff: daily.D[i] - daily.A[i] })).filter((x) => x.d >= WSTART);
  console.log("\n일별 수익률 차이(D−A) 절댓값 상위 10일");
  console.log("| 날짜 | A 일수익 % | D 일수익 % | 차이 %p | A 보유 | D 보유 | 기여 종목(D기여−A기여 %p) |\n|---|---|---|---|---|---|---|");
  for (const x of [...diffDays].sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff)).slice(0, 10)) {
    const mA = books.A.byDay.get(x.d) ?? new Map<string, number>(), mD = books.D.byDay.get(x.d) ?? new Map<string, number>();
    const cA = books.A.cnt.get(x.d) ?? 0, cD = books.D.cnt.get(x.d) ?? 0;
    const cs = new Set([...mA.keys(), ...mD.keys()]);
    const contrib = [...cs].map((c) => ({ c, v: ((mD.get(c) ?? 0) / Math.max(cD, 1) - (mA.get(c) ?? 0) / Math.max(cA, 1)) * 100 })).sort((a, b) => Math.abs(b.v) - Math.abs(a.v)).slice(0, 3);
    console.log(`| ${x.d} | ${f2(daily.A[x.i])} | ${f2(daily.D[x.i])} | ${f2(x.diff)} | ${cA} | ${cD} | ${contrib.map((z) => `${z.c}(${f2(z.v)})`).join(", ")} |`);
  }

  // 누적 차이 최대 하락 구간
  let cumA = 1, cumD = 1, peakGap = -Infinity, peakDate = WSTART, best = { peak: WSTART, trough: WSTART, drop: 0, peakGap: 0 };
  const gapSeries: { d: string; gap: number }[] = [];
  for (let i = 0; i < CAL.length; i++) {
    if (CAL[i] < WSTART) continue;
    cumA *= 1 + daily.A[i] / 100; cumD *= 1 + daily.D[i] / 100;
    const gap = (cumD - cumA) * 100;
    gapSeries.push({ d: CAL[i], gap });
    if (gap > peakGap) { peakGap = gap; peakDate = CAL[i]; }
    if (peakGap - gap > best.drop) best = { peak: peakDate, trough: CAL[i], drop: peakGap - gap, peakGap };
  }
  const gapAt = (d: string): number => gapSeries.find((x) => x.d === d)?.gap ?? NaN;
  console.log(`\n누적 수익률 차이(D−A, %p, 2021-03-01부터 각 변형 복리) 최대 하락 구간: ${best.peak}(${f2(best.peakGap)}) → ${best.trough}(${f2(gapAt(best.trough))}), 하락폭 ${f2(best.drop)}%p; 종료 시점 차이 ${f2(gapSeries[gapSeries.length - 1].gap)}%p`);
  const segDays = CAL.filter((d) => d > best.peak && d <= best.trough);
  const segContrib = new Map<string, number>();
  for (const d of segDays) {
    const mA = books.A.byDay.get(d) ?? new Map<string, number>(), mD = books.D.byDay.get(d) ?? new Map<string, number>();
    const cA = books.A.cnt.get(d) ?? 0, cD = books.D.cnt.get(d) ?? 0;
    for (const c of new Set([...mA.keys(), ...mD.keys()])) segContrib.set(c, (segContrib.get(c) ?? 0) + ((mD.get(c) ?? 0) / Math.max(cD, 1) - (mA.get(c) ?? 0) / Math.max(cA, 1)) * 100);
  }
  const inSeg = (d: string): boolean => d > best.peak && d <= best.trough;
  const delSeg = (b: VB): number => b.trades.filter((t) => t.delisted && inSeg(t.sellDate)).length;
  console.log(`구간 일수 ${segDays.length}, 일평균 보유 종목 수: A ${f2(mean(segDays.map((d) => books.A.cnt.get(d) ?? 0)))} | D ${f2(mean(segDays.map((d) => books.D.cnt.get(d) ?? 0)))}; 구간 내 상장폐지·거래정지 후 강제 청산 거래(청산일이 구간 안): A ${delSeg(books.A)}건 | D ${delSeg(books.D)}건`);
  console.log("구간 내 일별 기여(D−A) 합계 하위 5개 종목(%p)");
  console.log("| 종목 | 합계 %p | A 보유일 | D 보유일 |\n|---|---|---|---|");
  for (const [c, v] of [...segContrib.entries()].sort((a, b) => a[1] - b[1]).slice(0, 5)) console.log(`| ${c} | ${f2(v)} | ${segDays.filter((d) => books.A.byDay.get(d)?.has(c)).length} | ${segDays.filter((d) => books.D.byDay.get(d)?.has(c)).length} |`);

  // ---- 3 ----
  console.log("\n=== 3. 데이터 점검 ===");
  console.log(`로드 단계에서 제외된 행(접수일/접수번호 null): fill ok ${dropped.fillNull}건, dart_xbrl_fundamentals ${dropped.xbrlNull}건`);
  console.log(`D 거래(${TD.length}건)의 신호일 판정에 쓰인 재무 행(거래당 최대 3개, 중복 포함) 소스별 수 / 신호일보다 늦은 접수: stock ${usedCnt.stock}/${lateUsed.stock} | fill ${usedCnt.fill}/${lateUsed.fill} | xbrl ${usedCnt.xbrl}/${lateUsed.xbrl}`);
  const dOnly = [...used.D.entries()].filter(([k]) => ![...used.A.keys()].some((ak) => ak.split("|").slice(0, 2).join("|") === k.split("|").slice(0, 2).join("|") && ak.endsWith(`|${used.D.get(k)!.src}`)));
  const dOnlyBy = new Map<string, number>();
  for (const [, v] of dOnly) dOnlyBy.set(`${v.src}|${v.fy}`, (dOnlyBy.get(`${v.src}|${v.fy}`) ?? 0) + 1);
  console.log(`A 신호 판정에서 쓰이지 않았는데 D에서 쓰인 (종목, FY): 총 ${dOnly.length}건`);
  console.log("| 소스 | FY | 건수 |\n|---|---|---|");
  for (const [k, n] of [...dOnlyBy.entries()].sort()) { const [s, fy] = k.split("|"); console.log(`| ${s} | ${fy} | ${n} |`); }
  console.log("\n상장폐지·거래정지 후 강제 청산 / 기간 끝 미청산 평가 거래 (W2)");
  console.log("| 변형 | 상장폐지·정지 후 강제청산 건수 | 평균 거래 수익률 % | 미청산 평가 건수 | 평균 거래 수익률 % | 전체 거래 |\n|---|---|---|---|---|---|");
  for (const v of ["A", "B", "C", "D"] as V[]) {
    const ts = books[v].trades.filter((t) => t.buyDate >= WSTART);
    const de = ts.filter((t) => t.delisted), un = ts.filter((t) => t.forced && !t.delisted);
    console.log(`| ${v} | ${de.length} | ${f2(mean(de.map((t) => t.ret * 100)))} | ${un.length} | ${f2(mean(un.map((t) => t.ret * 100)))} | ${ts.length} |`);
  }
  console.log("\n2021-03~2021-06 월말: 진입 허용 구성원 중 PEG 상태 true 종목 수 vs 실제 보유");
  console.log("| 월말 | 구성원 | A true | A true 중 보유 | A 전체 보유 | D true | D true 중 보유 | D 전체 보유 |\n|---|---|---|---|---|---|---|---|");
  for (const d of sigMonths) {
    const e = sigM.get(d); if (!e) continue;
    const heldA = [...e.A].filter((c) => books.A.byDay.get(d)?.has(c)).length, heldD = [...e.D].filter((c) => books.D.byDay.get(d)?.has(c)).length;
    console.log(`| ${d} | ${e.members} | ${e.A.size} | ${heldA} | ${books.A.cnt.get(d) ?? 0} | ${e.D.size} | ${heldD} | ${books.D.cnt.get(d) ?? 0} |`);
  }

  // ---- 4 ----
  console.log("\n=== 4. 이전 검증(시작 2010-01)과의 대응 ===");
  const a2010S = S.A2010;
  console.log("| 구성 | 시작 인자 | 집계 시작 S | 2021 수익 % (1월 1일부터) | 2021 수익 % (3월 1일부터) | 거래 수(전체) |\n|---|---|---|---|---|---|");
  console.log(`| 이전 검증(사용자 제시) | 2010-01-01 | - | +${PRIOR_2021_PCT} | - | - |`);
  console.log(`| A2010 (이번 재계산, stock만, 시작 인자 2010-01-01) | 2010-01-01 | ${a2010S} | ${f2(yret(daily.A2010, 2021, "2021-01-01"))} | ${f2(yret(daily.A2010, 2021, "2021-03-01"))} | ${books.A2010.trades.length} |`);
  console.log(`| A (stock만, 시작 인자 2021-03-01) | 2021-03-01 | ${S.A} | ${f2(yret(daily.A, 2021, "2021-01-01"))} | ${f2(yret(daily.A, 2021, "2021-03-01"))} | ${books.A.trades.length} |`);
  const a2010Pre = books.A2010.trades.filter((t) => t.buyDate < WSTART);
  const a2010Open = a2010Pre.filter((t) => t.sellDate >= WSTART);
  console.log(`A2010에서 2021-03-01 이전에 매수한 거래 ${a2010Pre.length}건 (그중 2021-03-01 이후까지 보유 ${a2010Open.length}건); 2021-03-31 월말 보유 종목 수: A2010 ${books.A2010.cnt.get("2021-03-31") ?? 0} | A ${books.A.cnt.get("2021-03-31") ?? 0}`);
  console.log("코드 근거: lib/backtest.ts:362 `signals = detectStateTransitions(...).filter((s) => s.date >= windowStartDate)`, :367-375 진입은 golden 신호이고 열린 포지션이 없고 entryAllowed일 때만, :82 golden = 직전 상태 false→현재 true(undefined→true는 전환이 아님), :390-404 기간 끝 미청산은 마지막 봉 종가 강제청산; lib/strategyBacktestSummary.ts:84 `if (date < windowStartDate) continue;` (보유 중이어도 시작일 이전 일별 수익률은 집계 제외).");

  console.log("\n=== 실행 지표 ===");
  console.log(`Supabase 읽은 행: ${Object.entries(dbRead).map(([k, v]) => `${k} ${v}`).join(" | ")} | 합계 ${Object.values(dbRead).reduce((a, b) => a + b, 0)}`);
  console.log(`Supabase 쓴 행: 0 | 외부 요청: 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
}
main().catch((e) => { console.error(e); process.exit(1); });
