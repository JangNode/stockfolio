import { parquetReadObjects } from "hyparquet";
import type { StockDailyPriceRow } from "@/lib/stockDailyPricesStorage";

interface ParquetRawRow {
  stock_code: string;
  trade_date: string;
  close_price: number;
  market_cap_eok: number;
  listed_shares: number;
  // 2011~2026년 재백필(2026-09-06) 이전 연도 파일에는 아직 이 컬럼들이 없을 수 있다 —
  // 재백필 완료 전까지는 undefined일 수 있으므로 0으로 채운다.
  open_price?: number;
  volume?: number;
  high_price?: number;
  low_price?: number;
  trading_value?: number;
}

/** 연도 Parquet 파일 내용을 행 배열로 바꾼다. 캐시에서 읽었든 새로 받았든 같은 함수를 거친다. */
export async function parseYearPricesParquet(buffer: ArrayBuffer): Promise<StockDailyPriceRow[]> {
  const rows = (await parquetReadObjects({ file: buffer })) as ParquetRawRow[];
  return rows.map((r) => ({
    stockCode: r.stock_code,
    tradeDate: r.trade_date,
    closePrice: r.close_price,
    marketCapEok: r.market_cap_eok,
    listedShares: r.listed_shares,
    openPrice: r.open_price ?? 0,
    volume: r.volume ?? 0,
    highPrice: r.high_price ?? 0,
    lowPrice: r.low_price ?? 0,
    tradingValue: r.trading_value ?? 0,
  }));
}
