/**
 * [임시 점검 — 병합 금지, 읽기 전용] Supabase 전송량 제한 기간(10/13~10/14) 동안 놓친 것 점검.
 * DB 쓰기 없음. 읽는 것: 연결 확인 쿼리, hot 표 날짜별 행 수(count만), Parquet 2024~2026(약 49MB),
 * 추적 중인 KR 행(screening_results 수백 행), KRX 일별매매정보(10/12~10/14, 외부 API).
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchAllRows } from "@/lib/supabasePagination";
import { loadAllStockSeriesFromParquet, type StockDailyPriceRow } from "@/lib/stockDailyPricesStorage";
import { loadAppliedAdjustments } from "@/lib/stockPriceAdjustmentsStorage";
import { matchesEntrySignalToday, matchesSignalExitToday, type DailyPrice, type StrategyRule } from "@/lib/backtest";
import { MA_CROSS_V3_PARAMS, isMaCrossV3Signal, isMaCrossV2Signal } from "@/lib/maCrossConfig";
import { computeAvgTradingValueWon, passesKrSignalUniverse, usesSignalExit } from "@/lib/screeningSignalRules";

const KRX_BASE_URL = "https://data-dbg.krx.co.kr/svc/apis/sto";
const CHECK_DATES = ["2026-10-12", "2026-10-13", "2026-10-14"]; // 확인 대상 날짜
const SIGNAL_DATES = ["2026-10-12", "2026-10-13", "2026-10-14"]; // 10/12는 실제 등록분과 대조하는 검증용
const MISSED_BAR_DATES = ["2026-10-13", "2026-10-14"]; // 추적 갱신이 빠진 날
const COUNT_FROM = "2026-10-05";
const V3_RULE: StrategyRule = { rule_type: "ma_cross", rule_params: { ...MA_CROSS_V3_PARAMS } };

interface KrxTradeRow {
  ISU_CD: string; TDD_CLSPRC: string; TDD_OPNPRC: string; TDD_HGPRC: string; TDD_LWPRC: string;
  ACC_TRDVOL: string; ACC_TRDVAL: string; MKTCAP: string; LIST_SHRS: string;
}

async function fetchKrx(endpoint: "stk_bydd_trd" | "ksq_bydd_trd", dateKey: string, apiKey: string): Promise<KrxTradeRow[]> {
  const res = await fetch(`${KRX_BASE_URL}/${endpoint}?basDd=${dateKey.replaceAll("-", "")}`, { headers: { AUTH_KEY: apiKey } });
  if (!res.ok) throw new Error(`KRX HTTP ${res.status} (${endpoint} ${dateKey})`);
  const body = (await res.json()) as { OutBlock_1?: KrxTradeRow[] };
  return body.OutBlock_1 ?? [];
}

function toRow(r: KrxTradeRow, dateKey: string): StockDailyPriceRow | null {
  if (!r.ISU_CD || !r.TDD_CLSPRC || r.TDD_CLSPRC === "-" || !r.LIST_SHRS || r.LIST_SHRS === "-") return null;
  const marketCapEok = Number(r.MKTCAP) / 100_000_000;
  const row: StockDailyPriceRow = {
    stockCode: r.ISU_CD, tradeDate: dateKey, closePrice: Number(r.TDD_CLSPRC), marketCapEok, listedShares: Number(r.LIST_SHRS),
    openPrice: Number(r.TDD_OPNPRC), volume: Number(r.ACC_TRDVOL), highPrice: Number(r.TDD_HGPRC), lowPrice: Number(r.TDD_LWPRC),
    tradingValue: Number(r.ACC_TRDVAL),
  };
  return Object.values(row).every((v) => typeof v === "string" || Number.isFinite(v)) ? row : null;
}

const toPrices = (rows: StockDailyPriceRow[]): DailyPrice[] =>
  rows.map((r) => ({ date: r.tradeDate, open: r.openPrice, high: r.highPrice, low: r.lowPrice, close: r.closePrice, volume: r.volume, marketCapEok: r.marketCapEok, listedShares: r.listedShares }));

async function main(): Promise<void> {
  console.log(`놓친 기간 점검 시작(읽기 전용): ${new Date().toISOString()}`);
  const apiKey = process.env.KRX_API_KEY;
  if (!apiKey) throw new Error("KRX_API_KEY 없음");

  // 1) 연결 확인
  const latest = await supabaseAdmin.from("stock_daily_prices_recent").select("trade_date").order("trade_date", { ascending: false }).limit(1).maybeSingle();
  if (latest.error) throw new Error(`연결 확인 실패: ${latest.error.message}`);
  console.log(`[1] Supabase 조회 정상. hot 표 최신 거래일: ${latest.data?.trade_date ?? "없음"}`);

  // 3-a) hot 표 날짜별 행 수(count만)
  const hotCounts: string[] = [];
  for (let d = new Date(`${COUNT_FROM}T00:00:00Z`); d <= new Date("2026-10-15T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 1)) {
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    const key = d.toISOString().slice(0, 10);
    const { count, error } = await supabaseAdmin.from("stock_daily_prices_recent").select("stock_code", { count: "exact", head: true }).eq("trade_date", key);
    if (error) throw new Error(`hot 표 count 실패(${key}): ${error.message}`);
    hotCounts.push(`${key}: ${count}`);
  }
  console.log(`[3] hot 표 날짜별 행 수 -> ${hotCounts.join(" | ")}`);

  // 3-b) Parquet 2024~2026 + 날짜별 행 수
  const adjustments = await loadAppliedAdjustments();
  const series = await loadAllStockSeriesFromParquet(2024, 2026, adjustments);
  const parquetCounts = new Map<string, number>();
  let lastParquetDate = "";
  for (const rows of series.values()) {
    for (const r of rows) {
      if (r.tradeDate >= COUNT_FROM) parquetCounts.set(r.tradeDate, (parquetCounts.get(r.tradeDate) ?? 0) + 1);
      if (r.tradeDate > lastParquetDate) lastParquetDate = r.tradeDate;
    }
  }
  console.log(`[3] Parquet(2026.parquet 포함) 마지막 거래일 ${lastParquetDate}; 날짜별 행 수 -> ${[...parquetCounts].sort().map(([d, c]) => `${d}: ${c}`).join(" | ")}`);

  // 3-c) KRX 직접 조회(10/12~10/14, 외부 API): 날짜별 전체 종목 수와 시총 5천억 이상 수
  const krxByDate = new Map<string, StockDailyPriceRow[]>();
  for (const d of CHECK_DATES) {
    const [kospi, kosdaq] = await Promise.all([fetchKrx("stk_bydd_trd", d, apiKey), fetchKrx("ksq_bydd_trd", d, apiKey)]);
    const rows = [...kospi, ...kosdaq].map((r) => toRow(r, d)).filter((r): r is StockDailyPriceRow => r !== null);
    krxByDate.set(d, rows);
    console.log(`[3] KRX ${d}: 전체 ${rows.length}종목, 시총 5천억 이상 ${rows.filter((r) => r.marketCapEok >= 5000).length}종목`);
  }

  // Parquet 마지막 거래일 이후~10/14 KRX 행을 이어 붙인다(10/9 같은 휴장일은 0행).
  let appended = 0;
  const knownDates = new Set<string>();
  for (const rows of series.values()) for (const r of rows) knownDates.add(r.tradeDate);
  for (const [d, rows] of krxByDate) {
    if (knownDates.has(d)) continue;
    for (const r of rows) {
      const list = series.get(r.stockCode);
      if (list) { list.push(r); appended++; }
    }
  }
  console.log(`[4] KRX 행 ${appended}건을 Parquet 시리즈 뒤에 이어 붙임(10/12~10/14 중 Parquet에 없는 날)`);

  // 4) v3 신호 재생
  const registeredCodes = new Set<string>();
  const strategies = await supabaseAdmin.from("strategies").select("id, name, rule_type, market");
  if (strategies.error) throw new Error(strategies.error.message);
  const ruleById = new Map((strategies.data ?? []).map((s) => [s.id as string, s]));
  const maCrossKrIds = (strategies.data ?? []).filter((s) => s.rule_type === "ma_cross" && s.market === "KR").map((s) => s.id as string);
  const reg = await fetchAllRows<{ stock_code: string; matched_at: string; signal_details: unknown }>((from, to) =>
    supabaseAdmin.from("screening_results").select("stock_code, matched_at, signal_details").in("strategy_id", maCrossKrIds).gte("matched_at", "2026-10-12T00:00:00+09:00").order("id").range(from, to)
  );
  for (const r of reg) registeredCodes.add(`${r.matched_at.slice(0, 10)}:${r.stock_code}`);

  for (const sd of SIGNAL_DATES) {
    const hits: string[] = [];
    for (const [code, rows] of series) {
      const i = rows.findIndex((r) => r.tradeDate === sd);
      if (i < 0) continue;
      const upto = rows.slice(0, i + 1);
      const prices = toPrices(upto);
      const avgTv = computeAvgTradingValueWon(prices, prices.length - 1);
      if (!passesKrSignalUniverse("ma_cross", prices[prices.length - 1].marketCapEok ?? null, avgTv)) continue;
      if (matchesEntrySignalToday(prices, V3_RULE)) hits.push(`${code}(종가 ${prices[prices.length - 1].close}, 시총 ${Math.round(prices[prices.length - 1].marketCapEok ?? 0)}억)`);
    }
    const actual = [...registeredCodes].filter((k) => k.startsWith(sd)).length;
    console.log(`[4] v3 골든크로스 신호 ${sd}: ${hits.length}종목${sd === "2026-10-12" ? ` (검증: 10/12 실제 등록 ma_cross KR 행 ${actual}건)` : ""} -> ${hits.join(", ")}`);
  }

  // 5) 추적 중인 KR 행 영향
  const active = await fetchAllRows<{
    id: string; strategy_id: string; stock_code: string; status: string; entry_price: number; stop_loss_price: number; take_profit_price: number;
    current_price: number | null; matched_at: string; signal_details: Record<string, unknown> | null;
  }>((from, to) =>
    supabaseAdmin.from("screening_results").select("id, strategy_id, stock_code, status, entry_price, stop_loss_price, take_profit_price, current_price, matched_at, signal_details")
      .eq("market", "KR").in("status", ["active", "price_unavailable", "price_anomaly"]).order("id").range(from, to)
  );
  const usActive = await supabaseAdmin.from("screening_results").select("id", { count: "exact", head: true }).eq("market", "US").in("status", ["active", "price_unavailable", "price_anomaly"]);
  console.log(`[5] 추적 중 KR 행 ${active.length}건, US 행 ${usActive.count ?? "확인 불가"}건(US는 KRX 데이터가 없어 영향 판정 불가)`);

  const kind = (ruleType: string, d: unknown): string => {
    if (ruleType === "ma_cross") return isMaCrossV3Signal(d) ? "ma_cross v3(신호 이탈)" : isMaCrossV2Signal(d) ? "ma_cross v2(구)" : "ma_cross 구규칙(5/20, 7%/20%)";
    return usesSignalExit(d) ? `${ruleType}(신호 이탈)` : `${ruleType}(7%/20%)`;
  };
  const summary = new Map<string, { rows: number; stopTouched: number; takeTouched: number; stopClose: number; takeClose: number; exitNow: number; noBars: number }>();
  const detail: string[] = [];
  for (const row of active) {
    const s = ruleById.get(row.strategy_id);
    const ruleType = (s?.rule_type as string) ?? "unknown";
    const label = kind(ruleType, row.signal_details);
    const agg = summary.get(label) ?? { rows: 0, stopTouched: 0, takeTouched: 0, stopClose: 0, takeClose: 0, exitNow: 0, noBars: 0 };
    agg.rows++;
    const rows = series.get(row.stock_code);
    const missed = rows?.filter((r) => MISSED_BAR_DATES.includes(r.tradeDate)) ?? [];
    if (!rows || missed.length === 0) { agg.noBars++; summary.set(label, agg); continue; }
    if (usesSignalExit(row.signal_details)) {
      if (ruleType === "ma_cross" || ruleType === "reversal_breakout_v2") {
        const rule: StrategyRule = ruleType === "ma_cross" ? V3_RULE : { rule_type: "reversal_breakout_v2", rule_params: {} };
        for (const d of MISSED_BAR_DATES) {
          const i = rows.findIndex((r) => r.tradeDate === d);
          if (i >= 0 && matchesSignalExitToday(toPrices(rows.slice(0, i + 1)), rule)) { agg.exitNow++; detail.push(`${label} ${row.stock_code} ${d} 신호 이탈 상태`); break; }
        }
      } // peg_lynch는 재무 데이터가 필요해 재생하지 않음(확인 불가)
    } else {
      const lows = missed.map((r) => r.lowPrice), highs = missed.map((r) => r.highPrice), last = missed[missed.length - 1].closePrice;
      if (Math.min(...lows) <= row.stop_loss_price) { agg.stopTouched++; detail.push(`${label} ${row.stock_code} 저가가 손절선(${row.stop_loss_price}) 이하`); }
      if (Math.max(...highs) >= row.take_profit_price) { agg.takeTouched++; detail.push(`${label} ${row.stock_code} 고가가 익절선(${row.take_profit_price}) 이상`); }
      if (last <= row.stop_loss_price) agg.stopClose++;
      if (last >= row.take_profit_price) agg.takeClose++;
    }
    summary.set(label, agg);
  }
  for (const [label, a] of [...summary].sort()) {
    console.log(`[5] ${label}: 추적 ${a.rows}건 | 손절선 장중 도달 ${a.stopTouched} / 마지막 종가 손절선 이하 ${a.stopClose} | 익절선 장중 도달 ${a.takeTouched} / 마지막 종가 익절선 이상 ${a.takeClose} | 신호 이탈 상태 ${a.exitNow} | 시세 없음 ${a.noBars}`);
  }
  console.log(detail.slice(0, 60).join("\n"));
  console.log("완료");
}

main().catch((e) => { console.error(e); process.exit(1); });
