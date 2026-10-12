/**
 * [임시 검증 — 병합 금지, 읽기 전용] ma_cross v3 / 급등주 v2 / peg_lynch 재생 일치 검증.
 * (1) 2024년 하루씩 재생한 "새 스크리닝 로직"(lib/backtest.ts의 matchesEntrySignalToday·matchesSignalExitToday + lib/screeningSignalRules.ts 유니버스)이
 *     같은 기간 runBacktest 결과(진입일/청산일/종목)와 일치하는지, (2) 최근 구간 신호 수 추정(기존 대비).
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchAllRows } from "@/lib/supabasePagination";
import {
  DEFAULT_ON_OR_BEFORE_LOOKBACK_DAYS,
  loadAllStockSeriesFromParquet,
  type StockDailyPriceRow,
} from "@/lib/stockDailyPricesStorage";
import { loadAppliedAdjustments } from "@/lib/stockPriceAdjustmentsStorage";
import { loadFundamentalsSeriesWithListedShares } from "@/lib/stockFundamentals";
import { pickListedSharesOnOrBefore } from "@/lib/pitUniverse";
import { MA_CROSS_V3_PARAMS } from "@/lib/maCrossConfig";
import { computeSMA } from "@/lib/sma";
import { computeAvgTradingValueWon, passesKrSignalUniverse } from "@/lib/screeningSignalRules";
import {
  isGoldenTransition,
  matchesEntrySignalToday,
  matchesSignalExitToday,
  runBacktest,
  type DailyPrice,
  type StrategyRule,
  type StrategyRuleType,
} from "@/lib/backtest";

const FROM = "2024-01-01";
const TO = "2024-12-31";
const FROM_PEG = "2021-03-01"; // peg_lynch는 재무 데이터 한계로 첫 신호가 2021-03 이후라 이 구간부터 비교한다(2024만 보면 신규 진입이 3건뿐)
const RECENT_FROM = "2026-08-01";
const KIS_ROWS = 520; // 스크리닝이 받는 일봉 건수(급등주 v2 등록 시 520)
const RULES: Record<StrategyRuleType, StrategyRule> = {
  ma_cross: { rule_type: "ma_cross", rule_params: MA_CROSS_V3_PARAMS },
  reversal_breakout_v2: { rule_type: "reversal_breakout_v2", rule_params: {} },
  peg_lynch: { rule_type: "peg_lynch", rule_params: {} },
};

function toPrices(rows: StockDailyPriceRow[]): DailyPrice[] {
  return rows.map((r) => ({ date: r.tradeDate, open: r.openPrice, high: r.highPrice, low: r.lowPrice, close: r.closePrice, volume: r.volume, marketCapEok: r.marketCapEok, listedShares: r.listedShares }));
}

interface T { code: string; buy: string; sell: string; forced: boolean }
const key = (t: T): string => `${t.code}|${t.buy}|${t.forced ? "OPEN" : t.sell}`;

async function main(): Promise<void> {
  console.log(`재생 일치 검증 시작: ${new Date().toISOString()}`);
  const adjustments = await loadAppliedAdjustments();
  const series = await loadAllStockSeriesFromParquet(2010, new Date().getUTCFullYear(), adjustments);
  console.log(`종목 ${series.size}개`);

  const result: Record<string, { stocks: number; bt: number; replay: number; match: number; entryMissing: T[]; entryExtra: T[]; sellDiff: { bt: T; rp: T }[] }> = {};
  const recent: Record<string, Map<string, Set<string>>> = { ma_v3: new Map(), ma_v2: new Map(), v2_new: new Map(), peg_new: new Map() };

  // 급등주 v2/ma_cross 재생
  for (const [code, rows] of series) {
    if (!rows.some((r) => r.tradeDate >= FROM && r.tradeDate <= TO && r.marketCapEok >= 5000)) {
      // 2024 구간에 시총 5천억 이상인 날이 없으면 두 전략은 진입 불가 — 비교 대상에서 제외(최근 구간 집계는 아래에서 별도)
    }
    const prices = toPrices(rows);
    const upto = prices.filter((p) => p.date <= TO);
    const idxOfDate = new Map(upto.map((p, i) => [p.date, i]));
    for (const rt of ["ma_cross", "reversal_breakout_v2"] as const) {
      const eligible2024 = upto.some((p, i) => p.date >= FROM && passesKrSignalUniverse(rt, rows[i].marketCapEok, computeAvgTradingValueWon(upto, i)));
      if (!eligible2024) continue;
      const entryAllowed = (d: string): boolean => {
        const i = idxOfDate.get(d);
        return i !== undefined && passesKrSignalUniverse(rt, rows[i].marketCapEok, computeAvgTradingValueWon(upto, i));
      };
      const bt = runBacktest(upto, RULES[rt], FROM, undefined, undefined, { market: "KR", entryAllowed });
      const btTrades: T[] = bt.trades.map((t) => ({ code, buy: t.buyDate, sell: t.sellDate, forced: !!t.isForcedLiquidation }));

      const rp: T[] = [];
      let open: { buy: string } | null = null;
      for (let i = 1; i < upto.length; i++) {
        if (upto[i].date < FROM) continue;
        const window = upto.slice(Math.max(0, i - KIS_ROWS + 1), i + 1);
        if (open) {
          if (matchesSignalExitToday(window, RULES[rt])) { rp.push({ code, buy: open.buy, sell: upto[i].date, forced: false }); open = null; }
        } else if (passesKrSignalUniverse(rt, rows[i].marketCapEok, computeAvgTradingValueWon(upto, i)) && matchesEntrySignalToday(window, RULES[rt])) {
          open = { buy: upto[i].date };
        }
      }
      if (open) rp.push({ code, buy: open.buy, sell: upto[upto.length - 1].date, forced: true });
      const r = (result[rt] ??= { stocks: 0, bt: 0, replay: 0, match: 0, entryMissing: [], entryExtra: [], sellDiff: [] });
      r.stocks++; r.bt += btTrades.length; r.replay += rp.length;
      const rpMap = new Map(rp.map((t) => [t.buy, t])), btMap = new Map(btTrades.map((t) => [t.buy, t]));
      for (const t of btTrades) {
        const o = rpMap.get(t.buy);
        if (!o) r.entryMissing.push(t); else if (key(o) === key(t)) r.match++; else r.sellDiff.push({ bt: t, rp: o });
      }
      for (const t of rp) if (!btMap.has(t.buy)) r.entryExtra.push(t);
    }
  }

  // peg_lynch: 후보 풀(2011~ 시총 1조 이상 이력)만, 후보 유니버스 필터 없음(스크리닝과 동일)
  const pool: string[] = [];
  for (const [code, rows] of series) if (rows.some((r) => r.tradeDate >= "2011-01-01" && r.marketCapEok >= 10000)) pool.push(code);
  console.log(`peg 후보 풀 ${pool.length}종목`);
  let cursor = 0;
  async function pegWorker(): Promise<void> {
    for (;;) {
      const idx = cursor++;
      if (idx >= pool.length) return;
      const code = pool[idx];
      const rows = series.get(code)!;
      const prices = toPrices(rows);
      const upto = prices.filter((p) => p.date <= TO);
      if (upto.length < 3) continue;
      const loaded = await loadFundamentalsSeriesWithListedShares(code, (_c, d) => pickListedSharesOnOrBefore(rows, d, DEFAULT_ON_OR_BEFORE_LOOKBACK_DAYS));
      const bt = runBacktest(upto, RULES.peg_lynch, FROM_PEG, loaded.series, loaded.listedSharesByFiscalYear, { market: "KR" });
      const btTrades: T[] = bt.trades.map((t) => ({ code, buy: t.buyDate, sell: t.sellDate, forced: !!t.isForcedLiquidation }));
      const rp: T[] = [];
      let open: { buy: string } | null = null;
      for (let i = 1; i < upto.length; i++) {
        if (upto[i].date < FROM_PEG) continue;
        const window = [upto[i - 1], upto[i]]; // 스크리닝: 직전 거래일 봉 + 최근 봉
        if (open) {
          if (matchesSignalExitToday(window, RULES.peg_lynch, loaded.series, loaded.listedSharesByFiscalYear)) { rp.push({ code, buy: open.buy, sell: upto[i].date, forced: false }); open = null; }
        } else if (matchesEntrySignalToday(window, RULES.peg_lynch, loaded.series, loaded.listedSharesByFiscalYear)) {
          open = { buy: upto[i].date };
        }
      }
      if (open) rp.push({ code, buy: open.buy, sell: upto[upto.length - 1].date, forced: true });
      for (let i = 1; i < prices.length; i++) {
        if (prices[i].date < RECENT_FROM) continue;
        if (matchesEntrySignalToday([prices[i - 1], prices[i]], RULES.peg_lynch, loaded.series, loaded.listedSharesByFiscalYear)) {
          const m = recent.peg_new; if (!m.has(prices[i].date)) m.set(prices[i].date, new Set()); m.get(prices[i].date)!.add(code);
        }
      }
      const r = (result.peg_lynch ??= { stocks: 0, bt: 0, replay: 0, match: 0, entryMissing: [], entryExtra: [], sellDiff: [] });
      r.stocks++; r.bt += btTrades.length; r.replay += rp.length;
      const rpMap = new Map(rp.map((t) => [t.buy, t])), btMap = new Map(btTrades.map((t) => [t.buy, t]));
      for (const t of btTrades) { const o = rpMap.get(t.buy); if (!o) r.entryMissing.push(t); else if (key(o) === key(t)) r.match++; else r.sellDiff.push({ bt: t, rp: o }); }
      for (const t of rp) if (!btMap.has(t.buy)) r.entryExtra.push(t);
    }
  }
  await Promise.all(Array.from({ length: 10 }, pegWorker));

  console.log("\n=== (b) 재생 일치 (새 스크리닝 로직 vs runBacktest; ma_cross·급등주 v2는 2024-01-01~12-31, peg_lynch는 2021-03-01~2024-12-31) ===");
  for (const [rt, r] of Object.entries(result)) {
    console.log(`[${rt}] 비교 종목 ${r.stocks}, 백테스트 거래 ${r.bt}, 재생 거래 ${r.replay}, 완전 일치 ${r.match}, 진입 누락(백테스트에만) ${r.entryMissing.length}, 추가 진입(재생에만) ${r.entryExtra.length}, 같은 진입·다른 청산일 ${r.sellDiff.length}`);
    for (const t of r.entryMissing.slice(0, 6)) console.log(`   누락: ${t.code} 진입 ${t.buy} 청산 ${t.sell}${t.forced ? "(기간 끝 강제청산)" : ""}`);
    for (const t of r.entryExtra.slice(0, 6)) console.log(`   추가: ${t.code} 진입 ${t.buy} 청산 ${t.sell}${t.forced ? "(미청산)" : ""}`);
    for (const d of r.sellDiff.slice(0, 6)) console.log(`   청산 차이: ${d.bt.code} 진입 ${d.bt.buy} 백테스트 ${d.bt.sell}${d.bt.forced ? "(강제)" : ""} / 재생 ${d.rp.sell}${d.rp.forced ? "(미청산)" : ""}`);
  }

  // ---- (e) 최근 구간 신호 수 추정 ----
  console.log("\n=== (e) 최근 구간(2026-08-01~) 신호 수 추정 (새 규칙, 종목 수 기준; 전략 행 수는 계정별 시딩으로 ×5가 될 수 있음) ===");
  const add = (bucket: string, date: string, code: string): void => {
    const m = recent[bucket]; if (!m.has(date)) m.set(date, new Set()); m.get(date)!.add(code);
  };
  for (const [code, rows] of series) {
    const prices = toPrices(rows);
    const closes = prices.map((p) => p.close);
    const sShort = computeSMA(closes, MA_CROSS_V3_PARAMS.short_period);
    const sLong = computeSMA(closes, MA_CROSS_V3_PARAMS.long_period);
    const maState = prices.map((_, k) => (sShort[k] === undefined || sLong[k] === undefined ? undefined : sShort[k]! > sLong[k]!));
    for (let i = Math.max(1, prices.findIndex((p) => p.date >= RECENT_FROM)); i < prices.length; i++) {
      if (prices[i].date < RECENT_FROM) continue;
      const window = prices.slice(Math.max(0, i - KIS_ROWS + 1), i + 1);
      const avgTv = computeAvgTradingValueWon(prices, i);
      const cap = rows[i].marketCapEok;
      // ma_cross: v3(필터+유니버스) vs 이전 v2 규칙의 근사(골든크로스 + 시총 5천억, 거래대금·52주 필터 없음)
      if (cap >= 5000 && i >= 1 && isGoldenTransition(maState[i - 1], maState[i])) add("ma_v2", prices[i].date, code);
      if (passesKrSignalUniverse("ma_cross", cap, avgTv) && matchesEntrySignalToday(window, RULES.ma_cross)) add("ma_v3", prices[i].date, code);
      if (passesKrSignalUniverse("reversal_breakout_v2", cap, avgTv) && matchesEntrySignalToday(window, RULES.reversal_breakout_v2)) add("v2_new", prices[i].date, code);
    }
  }
  const tradingDays = new Set<string>();
  for (const rows of series.values()) for (const r of rows) if (r.tradeDate >= RECENT_FROM) tradingDays.add(r.tradeDate);
  const n = tradingDays.size;
  const sum = (m: Map<string, Set<string>>): number => [...m.values()].reduce((s, x) => s + x.size, 0);
  console.log(`거래일 ${n}일(${[...tradingDays].sort()[0]}~${[...tradingDays].sort()[n - 1]})`);
  console.log(`ma_cross 이전 v2 규칙 근사(골든크로스 + 시총 5천억): 총 ${sum(recent.ma_v2)}건, 하루 평균 ${(sum(recent.ma_v2) / n).toFixed(2)}건`);
  console.log(`ma_cross v3 신규 신호: 총 ${sum(recent.ma_v3)}건, 하루 평균 ${(sum(recent.ma_v3) / n).toFixed(2)}건`);
  console.log(`peg_lynch 신규 신호(전환 첫날, 후보 풀 ${pool.length}종목, 후보 풀 필터 그대로): 총 ${sum(recent.peg_new)}건, 하루 평균 ${(sum(recent.peg_new) / n).toFixed(2)}건`);
  console.log(`급등주 v2 신규 신호(전환 첫날 + 시총 5천억·거래대금 5억): 총 ${sum(recent.v2_new)}건, 하루 평균 ${(sum(recent.v2_new) / n).toFixed(2)}건`);

  // 기존 규칙의 실제 저장 건수(DB, 읽기 전용): 같은 기간 KR screening_results 신규 행
  const { data: strategies } = await supabaseAdmin.from("strategies").select("id, rule_type");
  const rt = new Map((strategies ?? []).map((s) => [s.id as string, s.rule_type as string]));
  const rowsDb = await fetchAllRows<{ strategy_id: string; matched_at: string; stock_code: string }>((from, to) =>
    supabaseAdmin.from("screening_results").select("strategy_id, matched_at, stock_code").eq("market", "KR").gte("matched_at", "2026-08-01T00:00:00Z").order("id").range(from, to));
  const byRule = new Map<string, { rows: number; stocks: Set<string> }>();
  for (const r of rowsDb) {
    const k = rt.get(r.strategy_id) ?? "?";
    const e = byRule.get(k) ?? { rows: 0, stocks: new Set() };
    e.rows++; e.stocks.add(`${r.matched_at.slice(0, 10)}|${r.stock_code}`);
    byRule.set(k, e);
  }
  for (const [k, e] of byRule) console.log(`[기존 규칙 실제 저장, 2026-08-01~] ${k}: 행 ${e.rows}건(일자·종목 고유 ${e.stocks.size}건), 하루 평균 고유 ${(e.stocks.size / n).toFixed(2)}건`);
  console.log("완료");
}
main().catch((e) => { console.error(e); process.exit(1); });
