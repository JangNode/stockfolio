import "server-only";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadAllStockSeriesFromParquet, type StockDailyPriceRow } from "@/lib/stockDailyPricesStorage";
import { loadAppliedAdjustments } from "@/lib/stockPriceAdjustmentsStorage";
import { applyAdjustmentsInPlace } from "@/lib/priceAdjustment";
import { computeTrailingAvgTradingValue } from "@/lib/pitUniverse";
import { PIT_LIQUIDITY_LOOKBACK_DAYS } from "@/lib/strategyBacktestSummaryConfig";
import { getIndexPriceSeries, getLatestIndexPriceDate, upsertIndexPrices } from "@/lib/betaPriceHistoryStorage";
import { indexStock, type IndexPoint } from "@/lib/marketRegime";
import type { PriceBook } from "@/lib/marketRegimeCompute";
import { REGIME_IDX_THROTTLE_MS, REGIME_RETRY_WAITS_MS } from "@/lib/marketRegimeConfig";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 연도 Parquet(전종목·상장폐지 포함)에서 [startYear, endYear] 시세를 읽어 종목별 조정 종가 묶음을 만든다.
 * 분할·병합 조정은 연구와 같이 종가·거래량에 최신 기준으로 적용하고, 20일 평균 거래대금은 직전 20개 행(당일 제외) 기준이다.
 */
export async function loadPriceBook(startYear: number, endYear: number): Promise<PriceBook> {
  const adjustments = await loadAppliedAdjustments();
  const series = await loadAllStockSeriesFromParquet(startYear, endYear);
  const book: PriceBook = new Map();
  for (const [code, rows] of series) {
    series.delete(code);
    if (!rows.length) continue;
    const adj: StockDailyPriceRow[] = rows.map((r) => ({ ...r }));
    const al = adjustments.get(code);
    if (al) applyAdjustmentsInPlace(adj, al);
    const base = indexStock({ code, dates: rows.map((r) => r.tradeDate), close: Float64Array.from(adj.map((r) => r.closePrice)) });
    book.set(code, { ...base, mcap: Float64Array.from(rows.map((r) => r.marketCapEok)), avgTv: computeTrailingAvgTradingValue(adj, PIT_LIQUIDITY_LOOKBACK_DAYS) });
  }
  return book;
}

/** 종목 이름(dart_corp_codes)과 KSIC(stock_industry_classification, 현재 값) — 제외 규칙 판정용. */
export async function loadNamesAndKsic(codes: string[]): Promise<{ names: Map<string, string>; ksic: Map<string, string> }> {
  const names = new Map<string, string>(), ksic = new Map<string, string>();
  const CHUNK = 200;
  for (let i = 0; i < codes.length; i += CHUNK) {
    const chunk = codes.slice(i, i + CHUNK);
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabaseAdmin.from("dart_corp_codes").select("corp_name, stock_code").in("stock_code", chunk).order("corp_code").range(from, from + 999);
      if (error) throw new Error(`종목 이름 조회 실패: ${error.message}`);
      for (const r of data ?? []) names.set(r.stock_code as string, r.corp_name as string);
      if ((data?.length ?? 0) < 1000) break;
    }
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabaseAdmin.from("stock_industry_classification").select("stock_code, induty_code").in("stock_code", chunk).order("stock_code").range(from, from + 999);
      if (error) throw new Error(`종목 업종 조회 실패: ${error.message}`);
      for (const r of data ?? []) if (r.induty_code) ksic.set(r.stock_code as string, r.induty_code as string);
      if ((data?.length ?? 0) < 1000) break;
    }
  }
  return { names, ksic };
}

export async function loadKospiSeries(startDate: string, endDate: string): Promise<IndexPoint[]> {
  return (await getIndexPriceSeries("KOSPI", startDate, endDate)).map((p) => ({ date: p.tradeDate, close: p.closePrice }));
}

const KRX_IDX_URL = "https://data-dbg.krx.co.kr/svc/apis/idx/kospi_dd_trd";
const addDays = (d: string, n: number): string => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

/** 호출 사이 대기(REGIME_IDX_THROTTLE_MS)를 지키고, 실패하면 5·15·60초 간격으로 재시도한다. 끝까지 실패하면 던진다(그날은 저장하지 않는다). */
async function fetchKospiClose(basDd: string, apiKey: string): Promise<number | null> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= REGIME_RETRY_WAITS_MS.length; attempt++) {
    await sleep(REGIME_IDX_THROTTLE_MS);
    try {
      const res = await fetch(`${KRX_IDX_URL}?basDd=${basDd.replaceAll("-", "")}`, { headers: { AUTH_KEY: apiKey }, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { OutBlock_1?: { IDX_NM: string; CLSPRC_IDX: string }[] };
      const row = (body.OutBlock_1 ?? []).find((r) => r.IDX_NM === "코스피");
      return row ? Number(row.CLSPRC_IDX.replaceAll(",", "")) : null; // 휴장일은 빈 응답 → null
    } catch (e) {
      lastError = e;
      if (attempt < REGIME_RETRY_WAITS_MS.length) await sleep(REGIME_RETRY_WAITS_MS[attempt]);
    }
  }
  throw new Error(`KRX 지수 ${basDd} 조회 실패(재시도 ${REGIME_RETRY_WAITS_MS.length}회): ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

/**
 * beta_price_history의 KOSPI를 target 날짜까지 증분 갱신한다(저장된 마지막 날 다음 평일부터, 빈 응답은 휴장일로 보고 건너뜀).
 * 기존 지수 갱신 배치와 같은 (market, trade_date) 표에 같은 값만 넣는다. 반환: 새로 저장한 일수.
 */
export async function refreshKospiIndexUpTo(target: string, maxGapDays: number): Promise<number> {
  const apiKey = process.env.KRX_API_KEY;
  if (!apiKey) throw new Error("KRX_API_KEY 환경 변수가 없습니다.");
  const last = await getLatestIndexPriceDate("KOSPI");
  if (!last) throw new Error("beta_price_history에 KOSPI 자료가 없습니다 — 지수 백필이 먼저 필요합니다.");
  if (last >= target) return 0;
  const days: string[] = [];
  for (let d = addDays(last, 1); d <= target; d = addDays(d, 1)) { const wd = new Date(`${d}T00:00:00Z`).getUTCDay(); if (wd !== 0 && wd !== 6) days.push(d); }
  if (days.length > maxGapDays) throw new Error(`KOSPI 지수가 ${last}까지만 있어 ${days.length}일을 따라잡아야 합니다(상한 ${maxGapDays}일) — 지수 백필(backfill:index-daily-prices)을 먼저 실행하세요.`);
  const rows: { market: "KOSPI"; tradeDate: string; closePrice: number }[] = [];
  for (const d of days) {
    const close = await fetchKospiClose(d, apiKey);
    if (close !== null && Number.isFinite(close) && close > 0) rows.push({ market: "KOSPI", tradeDate: d, closePrice: close });
  }
  await upsertIndexPrices(rows, { insertOnly: true });
  return rows.length;
}
