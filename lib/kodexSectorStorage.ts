import "server-only";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { downloadYearPrices, getDailyPricesForStocksOnOrBefore, type StockDailyPriceRow } from "@/lib/stockDailyPricesStorage";
import { loadAppliedAdjustmentsForCodes } from "@/lib/stockPriceAdjustmentsStorage";
import { applyAdjustmentsInPlace, type AppliedAdjustment } from "@/lib/priceAdjustment";
import { computeTrailingAvgTradingValue } from "@/lib/pitUniverse";
import { PIT_LIQUIDITY_LOOKBACK_DAYS } from "@/lib/strategyBacktestSummaryConfig";
import type { KssSignal, KssStockSeries } from "@/lib/kodexSectorSatellite";
import {
  KSS_KRX_BASE_URL,
  KSS_ETF_CODE,
  KSS_HISTORY_PAD_DAYS,
  KSS_NEXT_TRADING_DAY_SEARCH_DAYS,
  KSS_PRICE_LOOKBACK_DAYS,
  KSS_SATELLITE_WEIGHT,
  KSS_SECTOR_NAMES,
} from "@/lib/kodexSectorSatelliteConfig";

/**
 * KODEX 200 + 업종 모멘텀 위성 전략의 DB·KRX 입출력(서버 전용). 계산은 lib/kodexSectorSatellite.ts.
 * 외부 호출은 KRX Open API(sto/stk_bydd_trd, etp/etf_bydd_trd)만 쓴다 — KIS는 호출하지 않는다.
 */

const PAGE_SIZE = 1000;
const CHUNK = 200;

function addDays(dateIso: string, days: number): string {
  const d = new Date(`${dateIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---------------- KRX ----------------

export interface KrxStockDayRow {
  code: string;
  name: string;
  close: number;
  marketCapEok: number;
  volume: number;
  tradingValue: number;
  listedShares: number;
}

async function fetchKrx<T>(path: string, dateIso: string, apiKey: string): Promise<T[]> {
  const res = await fetch(`${KSS_KRX_BASE_URL}/${path}?basDd=${dateIso.replaceAll("-", "")}`, { headers: { AUTH_KEY: apiKey } });
  if (!res.ok) throw new Error(`KRX ${path}(${dateIso}) HTTP ${res.status}`);
  const body = (await res.json()) as { OutBlock_1?: T[] };
  return body.OutBlock_1 ?? [];
}

/** 신호일 KOSPI 전종목(sto/stk_bydd_trd 1회). 종가가 없거나 거래량 0인 행은 뺀다(Parquet 백필과 같은 규칙). */
export async function fetchKrxKospiDay(dateIso: string, apiKey: string): Promise<KrxStockDayRow[]> {
  const rows = await fetchKrx<Record<string, string>>("sto/stk_bydd_trd", dateIso, apiKey);
  const out: KrxStockDayRow[] = [];
  for (const r of rows) {
    if (!r.ISU_CD || !r.TDD_CLSPRC || r.TDD_CLSPRC === "-") continue;
    const close = Number(r.TDD_CLSPRC), marketCapEok = Number(r.MKTCAP) / 100_000_000;
    const volume = Number(r.ACC_TRDVOL), tradingValue = Number(r.ACC_TRDVAL), listedShares = Number(r.LIST_SHRS);
    if (![close, marketCapEok, volume, tradingValue].every(Number.isFinite) || volume === 0) continue;
    out.push({ code: r.ISU_CD, name: r.ISU_NM ?? "", close, marketCapEok, volume, tradingValue, listedShares });
  }
  return out;
}

/** 069500 원 종가(etp/etf_bydd_trd 1회). 없으면 null. */
export async function fetchKrxEtfClose(dateIso: string, apiKey: string): Promise<number | null> {
  const rows = await fetchKrx<Record<string, string>>("etp/etf_bydd_trd", dateIso, apiKey);
  const r = rows.find((x) => x.ISU_CD === KSS_ETF_CODE);
  const close = r ? Number(r.TDD_CLSPRC) : NaN;
  return Number.isFinite(close) && close > 0 ? close : null;
}

// ---------------- 거래일 캘린더 ----------------

/** dateIso 다음 개장일(krx_trading_calendar). 범위 안에 없으면 null. */
export async function getNextTradingDay(dateIso: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("krx_trading_calendar")
    .select("trade_date")
    .eq("is_open", true)
    .gt("trade_date", dateIso)
    .lte("trade_date", addDays(dateIso, KSS_NEXT_TRADING_DAY_SEARCH_DAYS))
    .order("trade_date", { ascending: true })
    .limit(1);
  if (error) throw new Error(`KRX 거래일 캘린더 조회 실패: ${error.message}`);
  return (data?.[0]?.trade_date as string | undefined) ?? null;
}

/** dateIso 이전 개장일(krx_trading_calendar). */
export async function getPrevTradingDay(dateIso: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("krx_trading_calendar")
    .select("trade_date")
    .eq("is_open", true)
    .lt("trade_date", dateIso)
    .gte("trade_date", addDays(dateIso, -KSS_NEXT_TRADING_DAY_SEARCH_DAYS))
    .order("trade_date", { ascending: false })
    .limit(1);
  if (error) throw new Error(`KRX 거래일 캘린더 조회 실패: ${error.message}`);
  return (data?.[0]?.trade_date as string | undefined) ?? null;
}

// ---------------- 신호 입력 ----------------

/** stock_daily_prices_recent에 들어 있는 가장 최근 날짜(이 날짜 이하 전체). */
export async function getLatestHotDate(): Promise<string | null> {
  const { data, error } = await supabaseAdmin.from("stock_daily_prices_recent").select("trade_date").order("trade_date", { ascending: false }).limit(1);
  if (error) throw new Error(`최근 시세 최신 날짜 조회 실패: ${error.message}`);
  return (data?.[0]?.trade_date as string | undefined) ?? null;
}

async function loadHotRows(codes: string[], fromDate: string, beforeDate: string): Promise<StockDailyPriceRow[]> {
  const out: StockDailyPriceRow[] = [];
  for (let i = 0; i < codes.length; i += CHUNK) {
    const chunk = codes.slice(i, i + CHUNK);
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await supabaseAdmin
        .from("stock_daily_prices_recent")
        .select("stock_code, trade_date, close_price, market_cap_eok, listed_shares, volume, trading_value")
        .in("stock_code", chunk)
        .gte("trade_date", fromDate)
        .lt("trade_date", beforeDate)
        .order("stock_code", { ascending: true })
        .order("trade_date", { ascending: true })
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw new Error(`최근 시세 조회 실패: ${error.message}`);
      for (const r of data ?? []) {
        const x = r as { stock_code: string; trade_date: string; close_price: number | string; market_cap_eok: number | string; listed_shares: number | string; volume: number | string; trading_value: number | string | null };
        out.push({ stockCode: x.stock_code, tradeDate: x.trade_date, closePrice: Number(x.close_price), marketCapEok: Number(x.market_cap_eok), listedShares: Number(x.listed_shares), openPrice: 0, volume: Number(x.volume), highPrice: 0, lowPrice: 0, tradingValue: Number(x.trading_value ?? 0) });
      }
      if (!data || data.length < PAGE_SIZE) break;
    }
  }
  return out;
}

async function selectByCodes<T>(table: string, columns: string, codeColumn: string, codes: string[]): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < codes.length; i += CHUNK) {
    const { data, error } = await supabaseAdmin.from(table).select(columns).in(codeColumn, codes.slice(i, i + CHUNK));
    if (error) throw new Error(`${table} 조회 실패: ${error.message}`);
    out.push(...((data ?? []) as T[]));
  }
  return out;
}

export interface KssLoadedInput {
  series: Map<string, KssStockSeries>;
  names: Map<string, string>;
  induty: Map<string, string>;
  adjustments: Map<string, AppliedAdjustment[]>;
}

/**
 * 신호일 입력을 모은다: 신호일 행(KRX 응답) + 그 전 행(모멘텀 시작 월말 한 달 전부터, hot 표 ∪ Parquet,
 * 같은 날짜는 Parquet 우선 — hot 표는 2026-09-29 이전 행에 거래대금(trading_value)이 비어 있어 종가×거래량으로
 * 대체되므로, 연구와 같은 값인 Parquet를 쓴다. 거래량 0 행 제외) → 분할·병합 조정 → 직전 20개 행 평균 거래대금.
 * 종목은 신호일 KOSPI 응답 종목만(K200P가 KOSPI 안에서만 뽑히므로).
 */
export async function loadKssSignalInput(signalDate: string, momentumFrom: string, kospiDay: KrxStockDayRow[]): Promise<KssLoadedInput> {
  const codes = kospiDay.map((r) => r.code);
  const codeSet = new Set(codes);
  const fromDate = addDays(momentumFrom, -KSS_HISTORY_PAD_DAYS);
  const byCode = new Map<string, Map<string, StockDailyPriceRow>>();
  const put = (r: StockDailyPriceRow): void => {
    if (!codeSet.has(r.stockCode) || r.tradeDate < fromDate || r.tradeDate >= signalDate || !(r.volume > 0)) return;
    let m = byCode.get(r.stockCode);
    if (!m) { m = new Map(); byCode.set(r.stockCode, m); }
    m.set(r.tradeDate, r);
  };
  for (const r of await loadHotRows(codes, fromDate, signalDate)) put(r);
  for (let y = Number(fromDate.slice(0, 4)); y <= Number(signalDate.slice(0, 4)); y++) for (const r of await downloadYearPrices(y)) put(r);

  const adjustments = await loadAppliedAdjustmentsForCodes(codes);
  const series = new Map<string, KssStockSeries>();
  for (const k of kospiDay) {
    const rows = [...(byCode.get(k.code)?.values() ?? [])].sort((a, b) => a.tradeDate.localeCompare(b.tradeDate)).map((r) => ({ ...r }));
    rows.push({ stockCode: k.code, tradeDate: signalDate, closePrice: k.close, marketCapEok: k.marketCapEok, listedShares: k.listedShares, openPrice: 0, volume: k.volume, highPrice: 0, lowPrice: 0, tradingValue: k.tradingValue });
    const al = adjustments.get(k.code);
    if (al) applyAdjustmentsInPlace(rows, al);
    series.set(k.code, { dates: rows.map((r) => r.tradeDate), close: rows.map((r) => r.closePrice), mcapEok: rows.map((r) => r.marketCapEok), avgTv: computeTrailingAvgTradingValue(rows, PIT_LIQUIDITY_LOOKBACK_DAYS) });
  }

  const names = new Map<string, string>(), induty = new Map<string, string>();
  for (const r of await selectByCodes<{ stock_code: string; corp_name: string }>("dart_corp_codes", "stock_code, corp_name", "stock_code", codes)) names.set(r.stock_code, r.corp_name);
  for (const r of await selectByCodes<{ stock_code: string; induty_code: string | null }>("stock_industry_classification", "stock_code, induty_code", "stock_code", codes)) if (r.induty_code) induty.set(r.stock_code, r.induty_code);
  return { series, names, induty, adjustments };
}

// ---------------- 저장·조회 ----------------

export interface KssSignalRow {
  signal_date: string;
  trade_date: string;
  momentum_from: string;
  momentum_to: string;
  k200p_count: number;
  sector_ranks: { sector: string; name: string; valid_count: number; momentum: number }[];
  top_sectors: string[];
  holdings: { code: string; name: string; sector: string; weight: number; account_weight: number }[];
  pre_trim_holdings: { code: string; name: string; sector: string; weight: number; account_weight: number }[];
  fallback_to_etf: boolean;
  signal_prices: Record<string, number>;
  computed_at: string;
}

export interface KssTrackRow {
  seed_won: number;
  trade_date: string;
  signal_date: string;
  value_before: number;
  value_after: number;
  cash: number;
  etf_shares: number;
  holdings: { code: string; shares: number; close: number }[];
  cap_hit: boolean;
  zero_satellite: boolean;
  mark_date: string;
  mark_value: number;
  computed_at: string;
}

export function toSignalRow(sig: KssSignal, tradeDate: string, names: Map<string, string>, prices: Record<string, number>): Omit<KssSignalRow, "computed_at"> {
  const h = (x: { code: string; sector: string; weight: number }): KssSignalRow["holdings"][number] => ({ code: x.code, name: names.get(x.code) ?? x.code, sector: x.sector, weight: x.weight, account_weight: x.weight * KSS_SATELLITE_WEIGHT });
  return {
    signal_date: sig.signalDate,
    trade_date: tradeDate,
    momentum_from: sig.momentumFrom,
    momentum_to: sig.momentumTo,
    k200p_count: sig.k200pCount,
    sector_ranks: sig.sectorRanks.map((r) => ({ sector: r.sector, name: KSS_SECTOR_NAMES[r.sector] ?? "", valid_count: r.validCount, momentum: r.momentum })),
    top_sectors: sig.topSectors,
    holdings: sig.holdings.map(h),
    pre_trim_holdings: sig.preTrimHoldings.map(h),
    fallback_to_etf: sig.fallbackToEtf,
    signal_prices: prices,
  };
}

export async function upsertKssSignal(row: Omit<KssSignalRow, "computed_at">): Promise<void> {
  const { error } = await supabaseAdmin.from("kodex_sector_signals").upsert({ ...row, computed_at: new Date().toISOString() });
  if (error) throw new Error(`kodex_sector_signals 저장 실패: ${error.message}`);
}

export async function upsertKssTrack(rows: Omit<KssTrackRow, "computed_at">[]): Promise<void> {
  if (rows.length === 0) return;
  const now = new Date().toISOString();
  const { error } = await supabaseAdmin.from("kodex_sector_track").upsert(rows.map((r) => ({ ...r, computed_at: now })));
  if (error) throw new Error(`kodex_sector_track 저장 실패: ${error.message}`);
}

export async function listKssSignals(limit?: number): Promise<KssSignalRow[]> {
  let q = supabaseAdmin.from("kodex_sector_signals").select("*").order("signal_date", { ascending: false });
  if (limit) q = q.limit(limit);
  const { data, error } = await q;
  if (error) throw new Error(`kodex_sector_signals 조회 실패: ${error.message}`);
  return (data ?? []) as KssSignalRow[];
}

export async function listKssTrack(): Promise<KssTrackRow[]> {
  const { data, error } = await supabaseAdmin.from("kodex_sector_track").select("*").order("trade_date", { ascending: true }).order("seed_won", { ascending: true });
  if (error) throw new Error(`kodex_sector_track 조회 실패: ${error.message}`);
  return ((data ?? []) as KssTrackRow[]).map((r) => ({ ...r, seed_won: Number(r.seed_won), value_before: Number(r.value_before), value_after: Number(r.value_after), cash: Number(r.cash), mark_value: Number(r.mark_value) }));
}

/** 모의 추적용 원 종가: 그날 행이 없으면 직전 행(KSS_PRICE_LOOKBACK_DAYS 안). */
export async function getRawClosesOnOrBefore(codes: string[], dateIso: string): Promise<Map<string, number>> {
  const rows = await getDailyPricesForStocksOnOrBefore(codes, dateIso, KSS_PRICE_LOOKBACK_DAYS);
  return new Map([...rows].map(([c, r]) => [c, r.closePrice]));
}

/** schedule_scrape_status의 'KODEX_SECTOR' 행(마지막 시도·성공 시각, 오류). 성공이면 위성 종목 수를 남긴다. */
export async function recordKssAttempt(errorMessage: string | null, holdingCount: number | null): Promise<void> {
  const now = new Date().toISOString();
  const update: Record<string, unknown> = { source: "KODEX_SECTOR", last_attempt_at: now };
  if (errorMessage) update.last_error = errorMessage;
  else { update.last_error = null; update.last_success_at = now; update.last_meeting_count = holdingCount; }
  const { error } = await supabaseAdmin.from("schedule_scrape_status").upsert(update);
  if (error) throw new Error(`KODEX 업종 모멘텀 상태 기록 실패: ${error.message}`);
}

export async function getKssStatus(): Promise<{ last_attempt_at: string | null; last_success_at: string | null; last_error: string | null } | null> {
  const { data, error } = await supabaseAdmin.from("schedule_scrape_status").select("last_attempt_at, last_success_at, last_error").eq("source", "KODEX_SECTOR").maybeSingle();
  if (error) throw new Error(`KODEX 업종 모멘텀 상태 조회 실패: ${error.message}`);
  return data;
}
