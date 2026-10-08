/**
 * [임시 조사 스크립트 — 병합 금지, 읽기 전용] 수정주가 low_confidence 이벤트가 ma_cross R0(50/200, 5천억 PIT,
 * 2010~, 비용 반영, 게이트 없음) 결과에 미치는 영향 조사. in-sample.
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { computeSMA } from "@/lib/sma";
import { aggregateTrades, type BacktestTrade, type DailyPrice } from "@/lib/backtest";
import { computeCostAdjustedReturnPct } from "@/lib/transactionCost";
import { loadAllStockSeriesFromParquet, type StockDailyPriceRow } from "@/lib/stockDailyPricesStorage";
import { computeTrailingAvgTradingValue } from "@/lib/pitUniverse";
import { loadAppliedAdjustments } from "@/lib/stockPriceAdjustmentsStorage";
import { MA_CROSS_V2_PARAMS } from "@/lib/maCrossConfig";
import { buildTradingDayIndex, detectAdjustmentEvents, snapSharesRatio } from "@/lib/priceAdjustment";
import { ADJUSTMENT_SNAP_RATIOS } from "@/lib/priceAdjustmentConfig";
import {
  STRATEGY_BACKTEST_PRICE_FETCH_LOOKBACK_YEARS,
  STOCK_DATA_EARLIEST_YEAR,
  PIT_LIQUIDITY_LOOKBACK_DAYS,
  PIT_MIN_AVG_TRADING_VALUE_WON,
} from "@/lib/strategyBacktestSummaryConfig";
import {
  accumulateStockDailyReturns,
  computeEqualWeightDailyReturns,
  computeCumulativeAndMdd,
  computeCagrPct,
  type DailyStockReturns,
  type StockContribution,
} from "@/lib/strategyBacktestSummary";
import { computeMonthlyRebalanceDates, simulateUniverseMonthlyRebalance } from "@/lib/benchmarkSummary";

const CAP_EOK = 5000;
const START = "2010-01-01";
const TODAY = new Date().toISOString().slice(0, 10);
const CURRENT_YEAR = new Date().getUTCFullYear();
const FETCH_START = Math.max(STOCK_DATA_EARLIEST_YEAR, 2010 - STRATEGY_BACKTEST_PRICE_FETCH_LOOKBACK_YEARS);
const PRE_CUTOFF = "2015-01-01"; // PRICE_ADJUSTMENT_SCAN_FROM_DATE — 이 날짜 이전 이벤트는 DB에 없다
const REASONS = ["shares_unchanged", "market_cap_discontinuity", "volume_disagrees", "post_ratio_out_of_range"] as const;
const SAMPLES_PER_REASON = 24;
const DELIST_GAP_DAYS = 10;

interface DbEvent {
  stock_code: string; event_date: string; price_ratio: number; shares_ratio: number; volume_ratio: number;
  status: string; low_confidence_reason: string | null;
  post_adjust_close_ratio: number | null; halt_trading_days: number | null;
  resume_day_change_pct: number | null; follow_5d_change_pct: number | null;
}

const num = (v: unknown): number => Number(v);
const fmt = (v: number, d = 2): string => (Number.isFinite(v) ? v.toFixed(d) : "NaN");
const median = (a: number[]): number => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const hash = (s: string): number => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); };

const BUCKETS: [string, (r: number) => boolean][] = [
  ["<0.3", (r) => r < 0.3], ["0.3~0.5", (r) => r >= 0.3 && r < 0.5], ["0.5~0.7", (r) => r >= 0.5 && r < 0.7],
  ["1.3~2", (r) => r > 1.3 && r <= 2], ["2~5", (r) => r > 2 && r <= 5], [">5", (r) => r > 5],
];

function isStandardShares(r: number): boolean {
  for (const t of ADJUSTMENT_SNAP_RATIOS) {
    if (Math.abs(r / t - 1) <= 0.05 || Math.abs(r * t - 1) <= 0.05) return true;
  }
  return false;
}

type Label = "미조정 분할/병합으로 보임" | "실제 급등락으로 보임" | "판단 불가";
function classify(priceRatio: number, sharesRatio: number, mcapRatio: number): { label: Label; why: string } {
  const sharesUnchanged = Math.abs(Math.log(sharesRatio)) <= 0.03;
  const mcapContinuous = Math.abs(Math.log(priceRatio * sharesRatio)) <= Math.log(1.3);
  if (!sharesUnchanged && isStandardShares(sharesRatio) && mcapContinuous) {
    return { label: "미조정 분할/병합으로 보임", why: `주식수비 ${fmt(sharesRatio)} 표준비율 + 가격×주식수 ${fmt(priceRatio * sharesRatio)}≈1 (시총 연속)` };
  }
  if (sharesUnchanged && Math.abs(Math.log(mcapRatio / priceRatio)) <= 0.1) {
    return { label: "실제 급등락으로 보임", why: `주식수 불변, 시총이 가격과 함께 ${fmt(mcapRatio)}배 변동` };
  }
  if (!sharesUnchanged && !mcapContinuous) {
    return { label: "판단 불가", why: `주식수비 ${fmt(sharesRatio)} 변동이나 가격×주식수 ${fmt(priceRatio * sharesRatio)}로 시총 불연속(증자·정지 재개 등 가능)` };
  }
  return { label: "판단 불가", why: `주식수비 ${fmt(sharesRatio)}, 시총비 ${fmt(mcapRatio)}, 가격비 ${fmt(priceRatio)} — 규칙으로 구분 안 됨` };
}

interface Acc { trades: BacktestTrade[]; dailyReturns: DailyStockReturns; contributions: Map<string, StockContribution>; start: string }
const newAcc = (start: string): Acc => ({ trades: [], dailyReturns: new Map(), contributions: new Map(), start });

async function fetchAllEvents(): Promise<DbEvent[]> {
  const out: DbEvent[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabaseAdmin
      .from("stock_price_adjustment_events")
      .select("stock_code, event_date, price_ratio, shares_ratio, volume_ratio, status, low_confidence_reason, post_adjust_close_ratio, halt_trading_days, resume_day_change_pct, follow_5d_change_pct")
      .order("stock_code").order("event_date").range(from, from + 999);
    if (error) throw new Error(error.message);
    for (const r of data ?? []) {
      const x = r as Record<string, unknown>;
      out.push({
        stock_code: String(x.stock_code), event_date: String(x.event_date),
        price_ratio: num(x.price_ratio), shares_ratio: num(x.shares_ratio), volume_ratio: num(x.volume_ratio),
        status: String(x.status), low_confidence_reason: (x.low_confidence_reason as string | null) ?? null,
        post_adjust_close_ratio: x.post_adjust_close_ratio == null ? null : num(x.post_adjust_close_ratio),
        halt_trading_days: x.halt_trading_days == null ? null : num(x.halt_trading_days),
        resume_day_change_pct: x.resume_day_change_pct == null ? null : num(x.resume_day_change_pct),
        follow_5d_change_pct: x.follow_5d_change_pct == null ? null : num(x.follow_5d_change_pct),
      });
    }
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function main(): Promise<void> {
  console.log(`low_confidence 영향 조사 시작(in-sample, 읽기 전용): ${new Date().toISOString()}`);
  const adjustments = await loadAppliedAdjustments();
  const seriesByCode = await loadAllStockSeriesFromParquet(FETCH_START, CURRENT_YEAR, adjustments);
  const events = await fetchAllEvents();
  const lowEvents = events.filter((e) => e.status === "low_confidence");
  const appliedEvents = events.filter((e) => e.status === "applied");
  const minDate = events.reduce((m, e) => (e.event_date < m ? e.event_date : m), "9999");
  console.log(`종목 ${seriesByCode.size}개, DB 이벤트 ${events.length}건(applied ${appliedEvents.length}, low_confidence ${lowEvents.length}), 이벤트 최소 날짜 ${minDate}`);

  const tdIndex = buildTradingDayIndex(seriesByCode);
  let lastDataDate = "";
  for (const rows of seriesByCode.values()) { const d = rows[rows.length - 1].tradeDate; if (d > lastDataDate) lastDataDate = d; }

  const lowByCode = new Map<string, DbEvent[]>();
  for (const e of lowEvents) { const l = lowByCode.get(e.stock_code) ?? []; l.push(e); lowByCode.set(e.stock_code, l); }
  const eventsByCode = new Map<string, DbEvent[]>();
  for (const e of events) { const l = eventsByCode.get(e.stock_code) ?? []; l.push(e); eventsByCode.set(e.stock_code, l); }

  // ---- 시나리오 정의 ----
  type Ctx = { code: string; lowEv: DbEvent[]; preDates: string[] };
  const overlaps = (t: BacktestTrade, dates: string[]): boolean => dates.some((d) => t.buyDate < d && d <= t.sellDate);
  const SCEN: { id: string; start: string; keep: (t: BacktestTrade, c: Ctx) => boolean }[] = [
    { id: "(a) 기존 그대로", start: START, keep: () => true },
    { id: "(b) low_confidence 보유 종목 전체 제외", start: START, keep: (_t, c) => c.lowEv.length === 0 },
    { id: "(c) low_confidence 이벤트와 겹치는 거래만 제외", start: START, keep: (t, c) => !overlaps(t, c.lowEv.map((e) => e.event_date)) },
    ...REASONS.map((r) => ({
      id: `(c-${r}) 해당 사유 이벤트와 겹치는 거래만 제외`, start: START,
      keep: (t: BacktestTrade, c: Ctx) => !overlaps(t, c.lowEv.filter((e) => e.low_confidence_reason === r).map((e) => e.event_date)),
    })),
    { id: "(p) 2015 이전 미기록 후보 이벤트(탐지 규칙 재적용, 모든 status)와 겹치는 거래 제외", start: START, keep: (t, c) => !overlaps(t, c.preDates) },
    { id: "(cp) (c) + (p) 동시 제외", start: START, keep: (t, c) => !overlaps(t, c.lowEv.map((e) => e.event_date)) && !overlaps(t, c.preDates) },
    { id: "[부분집합] low_confidence와 겹치는 거래만", start: START, keep: (t, c) => overlaps(t, c.lowEv.map((e) => e.event_date)) },
    { id: "[부분집합] 2015 이전 후보 이벤트와 겹치는 거래만", start: START, keep: (t, c) => overlaps(t, c.preDates) },
    { id: "[부분집합] (b)가 제거하지만 (c)는 유지하는 거래(보유 종목이나 이벤트와 안 겹침)", start: START, keep: (t, c) => c.lowEv.length > 0 && !overlaps(t, c.lowEv.map((e) => e.event_date)) },
    { id: "[부분집합] (b)가 제거하는 거래 중 이벤트가 매수 이전에만 있던(미래정보 아님) 거래", start: START, keep: (t, c) => c.lowEv.length > 0 && !overlaps(t, c.lowEv.map((e) => e.event_date)) && c.lowEv.every((e) => e.event_date <= t.buyDate) },
    { id: "[부분집합] (b)가 제거하는 거래 중 이벤트가 매도 이후에만 있던(미래정보) 거래", start: START, keep: (t, c) => c.lowEv.length > 0 && c.lowEv.every((e) => e.event_date > t.sellDate) },
    { id: "[참고] 2015-01-01 이후 진입만(조정 스캔 구간)", start: "2015-01-01", keep: (t) => t.buyDate >= "2015-01-01" },
    { id: "[참고] 2016-01-01 이후 진입만(기존 2016~ 기준 재현용)", start: "2016-01-01", keep: (t) => t.buyDate >= "2016-01-01" },
    { id: "[참고] 2016~ + (c)", start: "2016-01-01", keep: (t, c) => t.buyDate >= "2016-01-01" && !overlaps(t, c.lowEv.map((e) => e.event_date)) },
    { id: "[참고] 2016~ + (b)", start: "2016-01-01", keep: (t, c) => t.buyDate >= "2016-01-01" && c.lowEv.length === 0 },
  ];
  const accs = SCEN.map((s) => newAcc(s.start));
  const tradesByScen: BacktestTrade[][] = SCEN.map(() => []);
  const { short_period, long_period } = MA_CROSS_V2_PARAMS;

  // ---- 섹션 1·2 집계용 ----
  interface EligEvent { e: DbEvent; prev: StockDailyPriceRow; cur: StockDailyPriceRow; cur5: StockDailyPriceRow | undefined; gap: number }
  const eligLow: EligEvent[] = [];
  const preEligCounts = new Map<string, number>(); // 2015 이전 탐지, universe 기준 사유별
  const preEligRatios: number[] = [];
  const preStocks = new Set<string>();
  const preAllCounts = new Map<string, number>();
  const eligibleStocks = new Set<string>();
  const tradedStocks = new Set<string>();
  const delisted = new Set<string>();
  const dd50post2015 = new Set<string>();
  const dd50whole = new Set<string>();

  // 벤치마크 입력
  const pricesByStock = new Map<string, { date: string; close: number }[]>();
  const liquidityAt = new Map<string, Map<string, number>>();
  const allDates = new Set<string>();

  for (const [code, rows] of seriesByCode) {
    const n = rows.length;
    const prices: DailyPrice[] = rows.map((r) => ({
      date: r.tradeDate, open: r.openPrice, high: r.highPrice, low: r.lowPrice, close: r.closePrice,
      volume: r.volume, marketCapEok: r.marketCapEok, listedShares: r.listedShares,
    }));
    const avgTv = computeTrailingAvgTradingValue(rows, PIT_LIQUIDITY_LOOKBACK_DAYS);
    const eligAt = (i: number): boolean => i >= 0 && avgTv[i] >= PIT_MIN_AVG_TRADING_VALUE_WON && rows[i].marketCapEok >= CAP_EOK;
    const dateIdx = new Map<string, number>(rows.map((r, i) => [r.tradeDate, i]));
    for (const r of rows) allDates.add(r.tradeDate);
    pricesByStock.set(code, prices.map((p) => ({ date: p.date, close: p.close })));

    let everEligible = false;
    for (let i = 0; i < n; i++) if (rows[i].tradeDate >= START && eligAt(i)) { everEligible = true; break; }
    if (everEligible) {
      eligibleStocks.add(code);
      if (rows[n - 1].tradeDate < new Date(Date.parse(lastDataDate) - DELIST_GAP_DAYS * 86400000).toISOString().slice(0, 10)) delisted.add(code);
      let peak = 0, mdd = 0, peak2 = 0, mdd2 = 0;
      for (const r of rows) {
        if (r.closePrice > peak) peak = r.closePrice;
        mdd = Math.max(mdd, 1 - r.closePrice / peak);
        if (r.tradeDate >= PRE_CUTOFF) { if (r.closePrice > peak2) peak2 = r.closePrice; mdd2 = Math.max(mdd2, 1 - r.closePrice / peak2); }
      }
      if (mdd >= 0.5) dd50whole.add(code);
      if (mdd2 >= 0.5) dd50post2015.add(code);
    }

    // 벤치마크용 유동성(리밸런싱 날짜 필터는 아래에서 일괄 처리) — 날짜→평균거래대금(시총 조건 충족분만)
    const liq = new Map<string, number>();
    for (let i = 0; i < n; i++) if (Number.isFinite(avgTv[i]) && rows[i].marketCapEok >= CAP_EOK) liq.set(rows[i].tradeDate, avgTv[i]);
    liquidityAt.set(code, liq);

    // 2015 이전 후보 이벤트(DB에 없음) 재탐지
    const pre = detectAdjustmentEvents(rows, START, tdIndex).filter((e) => e.eventDate < PRE_CUTOFF);
    const preDates = pre.map((e) => e.eventDate);
    for (const e of pre) {
      const ci = dateIdx.get(e.eventDate)!;
      preAllCounts.set(`${e.status}/${e.lowConfidenceReason ?? "-"}`, (preAllCounts.get(`${e.status}/${e.lowConfidenceReason ?? "-"}`) ?? 0) + 1);
      if (eligAt(ci - 1)) {
        const key = `${e.status}/${e.lowConfidenceReason ?? "-"}`;
        preEligCounts.set(key, (preEligCounts.get(key) ?? 0) + 1);
        preEligRatios.push(e.priceRatio);
        preStocks.add(code);
      }
    }

    // low_confidence 이벤트 중 발생 시점에 유니버스였던 것
    const lowEv = lowByCode.get(code) ?? [];
    for (const e of lowEv) {
      const ci = dateIdx.get(e.event_date);
      if (ci === undefined || ci < 1) continue;
      if (eligAt(ci - 1)) {
        const prevIdx = tdIndex.get(rows[ci - 1].tradeDate), curIdx = tdIndex.get(rows[ci].tradeDate);
        eligLow.push({ e, prev: rows[ci - 1], cur: rows[ci], cur5: rows[ci + 5], gap: prevIdx !== undefined && curIdx !== undefined ? curIdx - prevIdx - 1 : NaN });
      }
    }

    // ---- R0 거래 ----
    const closes = prices.map((p) => p.close);
    const sShort = computeSMA(closes, short_period), sLong = computeSMA(closes, long_period);
    const goldens: number[] = [], deads: number[] = [];
    for (let i = 1; i < n; i++) {
      const ps = sShort[i - 1], pl = sLong[i - 1], cs = sShort[i], cl = sLong[i];
      if (ps === undefined || pl === undefined || cs === undefined || cl === undefined) continue;
      const prev = ps > pl, cur = cs > cl;
      if (!prev && cur && prices[i].date >= START) goldens.push(i);
      else if (prev && !cur && prices[i].date >= START) deads.push(i);
    }
    const trades: BacktestTrade[] = [];
    let nextAllowed = 0;
    for (const g of goldens) {
      if (g <= nextAllowed || !eligAt(g)) continue;
      const nd = deads.find((d) => d > g);
      const forced = nd === undefined;
      const s = forced ? n - 1 : nd;
      trades.push({
        buyDate: prices[g].date, buyPrice: prices[g].close, sellDate: prices[s].date, sellPrice: prices[s].close,
        returnPct: computeCostAdjustedReturnPct(prices[g].close, prices[s].close, prices[s].date, "KR"),
        ...(forced ? { isForcedLiquidation: true } : {}),
      });
      nextAllowed = s;
    }
    if (trades.length > 0) tradedStocks.add(code);
    const ctx: Ctx = { code, lowEv, preDates };
    SCEN.forEach((s, si) => {
      const kept = trades.filter((t) => s.keep(t, ctx));
      if (kept.length === 0) return;
      tradesByScen[si].push(...kept);
      accumulateStockDailyReturns(accs[si].dailyReturns, accs[si].contributions, code, prices, kept, s.start, "KR", true);
    });
  }

  // =============== 섹션 1: 사유별 분해 ===============
  console.log("\n=== [1] 사유별 분해 (DB low_confidence 이벤트, 2015-01-01 이후만 기록됨) ===");
  console.log(`전체 low_confidence ${lowEvents.length}건/${lowByCode.size}종목. 이 중 '발생 직전 거래일에 5천억·유동성 조건을 충족한 유니버스' 이벤트 ${eligLow.length}건/${new Set(eligLow.map((x) => x.e.stock_code)).size}종목`);
  for (const r of REASONS) {
    const all = lowEvents.filter((e) => e.low_confidence_reason === r);
    const el = eligLow.filter((x) => x.e.low_confidence_reason === r);
    const ratios = el.map((x) => x.e.price_ratio);
    const dist = BUCKETS.map(([l, f]) => `${l}:${ratios.filter(f).length}`).join(" ");
    const byYear = new Map<string, number>();
    for (const x of el) byYear.set(x.e.event_date.slice(0, 4), (byYear.get(x.e.event_date.slice(0, 4)) ?? 0) + 1);
    console.log(
      `[${r}] 전체 ${all.length}건/${new Set(all.map((e) => e.stock_code)).size}종목 | 유니버스 ${el.length}건/${new Set(el.map((x) => x.e.stock_code)).size}종목 | 가격비(전후 종가비) 중앙 ${fmt(median(ratios))} 분포 ${dist} | 연도별 ${[...byYear].sort().map(([y, c]) => `${y}:${c}`).join(" ")}`
    );
  }
  console.log(`참고: applied 이벤트 ${appliedEvents.length}건/${new Set(appliedEvents.map((e) => e.stock_code)).size}종목(배치가 조정에 사용)`);
  console.log(`[2015 이전 구간] DB에는 이벤트 없음(스캔 시작 ${PRE_CUTOFF}). 같은 탐지 규칙을 2010~2014에 재적용: 전체 ${[...preAllCounts].map(([k, v]) => `${k}=${v}`).join(" ")} | 유니버스 ${[...preEligCounts].map(([k, v]) => `${k}=${v}`).join(" ")} (${preStocks.size}종목), 가격비 중앙 ${fmt(median(preEligRatios))}`);

  // =============== 섹션 2: 표본 + 모집단 분류 ===============
  console.log("\n=== [2] 표본(사유별 유니버스 이벤트 중 결정적 해시 순 24개) + 규칙 기반 분류 ===");
  const labelCount = new Map<string, Map<Label, number>>();
  for (const x of eligLow) {
    const r = x.e.low_confidence_reason ?? "-";
    const mcapRatio = x.cur.marketCapEok / x.prev.marketCapEok;
    const { label } = classify(x.e.price_ratio, x.e.shares_ratio, mcapRatio);
    const m = labelCount.get(r) ?? new Map<Label, number>();
    m.set(label, (m.get(label) ?? 0) + 1);
    labelCount.set(r, m);
  }
  for (const r of REASONS) {
    const m = labelCount.get(r) ?? new Map();
    console.log(`[모집단 분류 ${r}] ${[...m].map(([l, c]) => `${l}=${c}`).join(" | ")}`);
  }
  for (const r of REASONS) {
    const pick = eligLow.filter((x) => x.e.low_confidence_reason === r).sort((a, b) => hash(a.e.stock_code + a.e.event_date) - hash(b.e.stock_code + b.e.event_date)).slice(0, SAMPLES_PER_REASON);
    console.log(`--- ${r} 표본 ${pick.length}개 ---`);
    for (const x of pick) {
      const mcapRatio = x.cur.marketCapEok / x.prev.marketCapEok;
      const { label, why } = classify(x.e.price_ratio, x.e.shares_ratio, mcapRatio);
      const f5 = x.cur5 ? `${fmt((x.cur5.closePrice / x.cur.closePrice - 1) * 100, 1)}%` : "n/a";
      console.log(
        `${x.e.stock_code} ${x.e.event_date} | 종가 ${x.prev.closePrice}→${x.cur.closePrice}(원본비 ${fmt(x.e.price_ratio)}) | 거래량 ${x.prev.volume}→${x.cur.volume}(${fmt(x.e.volume_ratio)}배) | ` +
          `상장주식수 ${x.prev.listedShares}→${x.cur.listedShares}(탐지비 ${fmt(x.e.shares_ratio)}) | 시총(억) ${x.prev.marketCapEok}→${x.cur.marketCapEok} | 정지일 ${fmt(x.gap, 0)} | 5일후 ${f5} | ` +
          `→ ${label}: ${why}`
      );
    }
  }

  // =============== 섹션 3: 거래 단위 영향 ===============
  console.log("\n=== [3] 거래 단위 영향 (R0, 5천억 PIT, 비용 반영, in-sample) ===");
  SCEN.forEach((s, si) => {
    const t = tradesByScen[si];
    if (t.length === 0) { console.log(`${s.id}: 거래 없음`); return; }
    const agg = aggregateTrades(t);
    const daily = computeEqualWeightDailyReturns(accs[si].dailyReturns);
    const { totalReturnPct, mddPct } = computeCumulativeAndMdd(daily);
    const cagr = computeCagrPct(totalReturnPct, s.start, TODAY);
    const wins = t.filter((x) => x.returnPct > 0), losses = t.filter((x) => x.returnPct <= 0);
    const aw = (wins.reduce((a, x) => a + x.returnPct, 0) / Math.max(wins.length, 1)) * 100;
    const al = (losses.reduce((a, x) => a + x.returnPct, 0) / Math.max(losses.length, 1)) * 100;
    const avg = (t.reduce((a, x) => a + x.returnPct, 0) / t.length) * 100;
    console.log(`${s.id}: CAGR ${fmt(cagr, 1)}% | MDD ${fmt(mddPct, 1)}% | 거래 ${t.length} | 승률 ${fmt(agg.winRate * 100, 1)}% | 손익비 ${fmt(aw / Math.abs(al || 1))} | 거래당 평균 ${fmt(avg, 1)}% | 합계수익률기여(단순합) ${fmt(t.reduce((a, x) => a + x.returnPct, 0) * 100, 0)}%p`);
  });

  // =============== 섹션 4: 편향 ===============
  console.log("\n=== [4] 편향 점검 (유니버스 = 2010~ 한 번이라도 5천억·유동성 조건을 충족한 종목) ===");
  const excluded = [...eligibleStocks].filter((c) => lowByCode.has(c));
  const kept = [...eligibleStocks].filter((c) => !lowByCode.has(c));
  const pct = (a: string[], s: Set<string>): string => `${a.filter((c) => s.has(c)).length}/${a.length} (${fmt((a.filter((c) => s.has(c)).length / Math.max(a.length, 1)) * 100, 1)}%)`;
  console.log(`(b)에서 빠진 유니버스 종목 ${excluded.length} / 남은 ${kept.length} / 전체 ${eligibleStocks.size}`);
  console.log(`상장폐지(마지막 행이 최신일-${DELIST_GAP_DAYS}일 이전): 빠진 ${pct(excluded, delisted)} vs 남은 ${pct(kept, delisted)}`);
  console.log(`최대낙폭 -50% 이상(2010~ 전 기간, 2015 이전 미조정 분할 포함이라 과대 가능): 빠진 ${pct(excluded, dd50whole)} vs 남은 ${pct(kept, dd50whole)}`);
  console.log(`최대낙폭 -50% 이상(2015-01-01 이후만, 조정 스캔 구간): 빠진 ${pct(excluded, dd50post2015)} vs 남은 ${pct(kept, dd50post2015)}`);
  const exTraded = excluded.filter((c) => tradedStocks.has(c)), kpTraded = kept.filter((c) => tradedStocks.has(c));
  console.log(`R0 거래 발생 종목 기준: 빠진 ${exTraded.length}종목 상장폐지 ${pct(exTraded, delisted)}, dd50(2015~) ${pct(exTraded, dd50post2015)} | 남은 ${kpTraded.length}종목 상장폐지 ${pct(kpTraded, delisted)}, dd50(2015~) ${pct(kpTraded, dd50post2015)}`);

  // =============== 섹션 5: 동일가중 유니버스 벤치마크 (종목 거래일 캘린더) ===============
  console.log("\n=== [5] 동일가중 유니버스 벤치마크: 종목 거래일 합집합 캘린더로 계산 (5천억 PIT, 유동성 5억, 비용 반영) ===");
  const calendar = Array.from(allDates).filter((d) => d >= START).sort();
  const rebal = computeMonthlyRebalanceDates(calendar);
  const eligibleAt = (code: string, date: string): boolean => (liquidityAt.get(code)?.get(date) ?? NaN) >= PIT_MIN_AVG_TRADING_VALUE_WON;
  void rebal;
  for (const start of ["2010-01-01", "2016-01-01"]) {
    const daily = simulateUniverseMonthlyRebalance(pricesByStock, calendar, start, eligibleAt, true);
    const { totalReturnPct, mddPct } = computeCumulativeAndMdd(daily);
    console.log(`시작 ${start}: CAGR ${fmt(computeCagrPct(totalReturnPct, start, TODAY), 1)}% | MDD ${fmt(mddPct, 1)}% | 캘린더 첫날 ${calendar.find((d) => d >= start)} (${calendar.length}거래일)`);
  }
  console.log("완료");
}

void snapSharesRatio;
main().catch((e) => { console.error(e); process.exit(1); });
