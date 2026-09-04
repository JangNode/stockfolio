import "server-only";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import type { KrxMarket } from "@/lib/stockMaster";

/**
 * 종목별로 분기 1회 미리 계산해두는 베타(stock_beta) 접근. 계산은
 * scripts/calc-stock-beta.ts(lib/beta.ts의 computeBetaFromPrices)가 하고,
 * app/api/stock/[code]/valuation 라우트는 이 표를 조회만 한다(요청마다 회귀를
 * 다시 돌리지 않는다).
 */

const TABLE = "stock_beta";

export interface StockBetaRow {
  stockCode: string;
  market: KrxMarket;
  beta: number | null;
  dataPoints: number;
  windowStartDate: string;
  windowEndDate: string;
}

interface StockBetaDbRow {
  stock_code: string;
  market: KrxMarket;
  beta: number | string | null;
  data_points: number;
  window_start_date: string;
  window_end_date: string;
}

export async function getStockBeta(stockCode: string): Promise<StockBetaRow | null> {
  const { data, error } = await supabaseAdmin
    .from(TABLE)
    .select("stock_code, market, beta, data_points, window_start_date, window_end_date")
    .eq("stock_code", stockCode)
    .maybeSingle();
  if (error) throw new Error(`${stockCode} 베타 조회 실패: ${error.message}`);
  if (!data) return null;
  const row = data as StockBetaDbRow;
  return {
    stockCode: row.stock_code,
    market: row.market,
    beta: row.beta === null ? null : Number(row.beta),
    dataPoints: row.data_points,
    windowStartDate: row.window_start_date,
    windowEndDate: row.window_end_date,
  };
}

export async function upsertStockBetas(rows: StockBetaRow[]): Promise<void> {
  if (rows.length === 0) return;
  const { error } = await supabaseAdmin.from(TABLE).upsert(
    rows.map((r) => ({
      stock_code: r.stockCode,
      market: r.market,
      beta: r.beta,
      data_points: r.dataPoints,
      window_start_date: r.windowStartDate,
      window_end_date: r.windowEndDate,
      computed_at: new Date().toISOString(),
    }))
  );
  if (error) throw new Error(`베타 저장 실패: ${error.message}`);
}
