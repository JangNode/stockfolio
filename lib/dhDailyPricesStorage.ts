import "server-only";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { parquetReadObjects } from "hyparquet";
import { parquetWriteBuffer } from "hyparquet-writer";

/**
 * DH전략 일별시세(종가/시가총액/상장주식수)는 연도별 Parquet 파일로 Supabase
 * Storage(dh-daily-prices 버킷)에 저장한다 — Postgres DB 대신 쓰는 이유는
 * supabase/migrations의 20260827060000_dh_daily_prices_to_storage.sql 코멘트 참고
 * (DB 500MB 무료 한도를 이미 넘겨서, 별도 쿼터인 Storage로 옮김). 조회 시 그 시점
 * 재무(dh_annual_fundamentals, 여전히 Postgres)와 조합해 PER/PBR을 계산하는 건
 * lib/dhFundamentals.ts가 한다.
 */

const BUCKET = "dh-daily-prices";

export interface DhDailyPriceRow {
  stockCode: string;
  tradeDate: string; // YYYY-MM-DD
  closePrice: number;
  marketCapEok: number;
  listedShares: number;
}

function objectPath(year: number): string {
  return `${year}.parquet`;
}

/** 한 해치 시세를 Parquet로 직렬화해 업로드한다(덮어쓰기). 연도 단위 파일이라 한 해가
 * 통째로 성공했을 때만 부른다 — 중간에 실패하면 그 해는 아예 안 올라가므로, 이전에
 * 이미 올라간 다른 해 파일이 부분 데이터로 오염될 일이 없다. */
export async function uploadYearPrices(year: number, rows: DhDailyPriceRow[]): Promise<void> {
  const buffer = parquetWriteBuffer({
    columnData: [
      { name: "stock_code", data: rows.map((r) => r.stockCode), type: "STRING" },
      { name: "trade_date", data: rows.map((r) => r.tradeDate), type: "STRING" },
      { name: "close_price", data: rows.map((r) => r.closePrice), type: "DOUBLE" },
      { name: "market_cap_eok", data: rows.map((r) => r.marketCapEok), type: "DOUBLE" },
      { name: "listed_shares", data: rows.map((r) => r.listedShares), type: "DOUBLE" },
    ],
  });

  const { error } = await supabaseAdmin.storage.from(BUCKET).upload(objectPath(year), buffer, {
    contentType: "application/octet-stream",
    upsert: true,
  });
  if (error) throw new Error(`${year}년 시세 업로드 실패: ${error.message}`);
}

/** 특정 연도 파일이 이미 Storage에 있는지 확인한다(백필 재개 시 완료된 연도를 건너뛰는 데 씀). */
export async function yearPricesExist(year: number): Promise<boolean> {
  const { data, error } = await supabaseAdmin.storage.from(BUCKET).list("", { search: objectPath(year) });
  if (error) throw new Error(`${year}년 시세 존재 확인 실패: ${error.message}`);
  return (data ?? []).some((entry) => entry.name === objectPath(year));
}

interface ParquetRawRow {
  stock_code: string;
  trade_date: string;
  close_price: number;
  market_cap_eok: number;
  listed_shares: number;
}

async function downloadYearPrices(year: number): Promise<DhDailyPriceRow[]> {
  const { data, error } = await supabaseAdmin.storage.from(BUCKET).download(objectPath(year));
  if (error) {
    // 아직 그 연도 파일이 없는 경우(예: 미래 연도, 백필 전)는 빈 배열로 취급한다.
    if (error.message.toLowerCase().includes("not found")) return [];
    throw new Error(`${year}년 시세 다운로드 실패: ${error.message}`);
  }
  const buffer = await data.arrayBuffer();
  const rows = (await parquetReadObjects({ file: buffer })) as ParquetRawRow[];
  return rows.map((r) => ({
    stockCode: r.stock_code,
    tradeDate: r.trade_date,
    closePrice: r.close_price,
    marketCapEok: r.market_cap_eok,
    listedShares: r.listed_shares,
  }));
}

// 프로세스(스크립트 1회 실행 또는 서버리스 함수 인스턴스) 생존 기간 동안만 유지되는
// 연도별 캐시. 같은 실행 안에서 같은 연도를 여러 번 조회하는 경우(백테스트가 여러
// 종목×여러 날짜를 훑을 때 흔함)가 많아, 매번 다시 내려받지 않게 한다.
const yearCache = new Map<number, Promise<Map<string, DhDailyPriceRow>>>();

function toLookupKey(stockCode: string, tradeDate: string): string {
  return `${stockCode}:${tradeDate}`;
}

async function getYearLookup(year: number): Promise<Map<string, DhDailyPriceRow>> {
  let cached = yearCache.get(year);
  if (!cached) {
    cached = downloadYearPrices(year).then((rows) => {
      const map = new Map<string, DhDailyPriceRow>();
      for (const row of rows) map.set(toLookupKey(row.stockCode, row.tradeDate), row);
      return map;
    });
    yearCache.set(year, cached);
  }
  return cached;
}

/** date(YYYY-MM-DD) 시점 종목의 종가/시가총액/상장주식수를 찾는다. 그 연도 파일에
 * 없으면(비영업일, 백필 하한 미달 등) null. */
export async function getDailyPrice(stockCode: string, date: string): Promise<DhDailyPriceRow | null> {
  const year = Number(date.slice(0, 4));
  const lookup = await getYearLookup(year);
  return lookup.get(toLookupKey(stockCode, date)) ?? null;
}

/** 여러 연도에 걸쳐 minMarketCapEok(억원) 이상이었던 적 있는 종목코드 집합을 반환한다
 * — DART/배당 백필의 후보종목 발굴에 쓴다. 저장 자체는 더 낮은 하한
 * (DH_BACKFILL_MARKET_CAP_FLOOR_EOK)으로 돼 있으므로, 여기서 DH전략 실제 기준
 * (DH_MIN_MARKET_CAP_EOK)으로 다시 걸러야 한다. */
export async function discoverCandidateStockCodes(years: number[], minMarketCapEok: number): Promise<string[]> {
  const codes = new Set<string>();
  for (const year of years) {
    const lookup = await getYearLookup(year);
    for (const row of lookup.values()) {
      if (row.marketCapEok >= minMarketCapEok) codes.add(row.stockCode);
    }
  }
  return Array.from(codes);
}
