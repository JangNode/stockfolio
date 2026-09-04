import "server-only";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import type { KrxMarket } from "@/lib/stockMaster";
import type { PricePoint } from "@/lib/beta";

/**
 * 적정주가 베타 계산용 코스피/코스닥 지수 일별 종가(beta_price_history) 접근.
 * scripts/backfill-index-daily-prices.ts가 채우고, scripts/calc-stock-beta.ts가
 * 읽는다. 종목 개별 시세(lib/stockDailyPricesStorage.ts)와 달리 지수 두 종류뿐이라
 * hot/cold 분리 없이 단일 표로 둔다.
 */

const TABLE = "beta_price_history";

interface BetaPriceHistoryRow {
  market: KrxMarket;
  trade_date: string;
  close_price: number;
}

/** market의 가장 최근 저장 날짜(YYYY-MM-DD). 백필 스크립트가 이어받을 시작일을
 * 판단하는 데 쓴다. 표가 비어있으면 null. */
export async function getLatestIndexPriceDate(market: KrxMarket): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from(TABLE)
    .select("trade_date")
    .eq("market", market)
    .order("trade_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`${market} 지수 시세 최신 날짜 조회 실패: ${error.message}`);
  return data?.trade_date ?? null;
}

export async function upsertIndexPrices(
  rows: { market: KrxMarket; tradeDate: string; closePrice: number }[]
): Promise<void> {
  if (rows.length === 0) return;
  const { error } = await supabaseAdmin.from(TABLE).upsert(
    rows.map((r) => ({ market: r.market, trade_date: r.tradeDate, close_price: r.closePrice }))
  );
  if (error) throw new Error(`지수 시세 저장 실패: ${error.message}`);
}

/** market의 [startDate, endDate](양 끝 포함) 구간 지수 종가를 tradeDate 오름차순으로
 * 반환한다 — 베타 계산 배치가 종목마다 반복 조회하지 않도록 한 번만 캐시해 쓴다. */
export async function getIndexPriceSeries(
  market: KrxMarket,
  startDate: string,
  endDate: string
): Promise<PricePoint[]> {
  const { data, error } = await supabaseAdmin
    .from(TABLE)
    .select("market, trade_date, close_price")
    .eq("market", market)
    .gte("trade_date", startDate)
    .lte("trade_date", endDate)
    .order("trade_date", { ascending: true });
  if (error) throw new Error(`${market} 지수 시세 구간 조회 실패: ${error.message}`);
  return (data ?? []).map((row: BetaPriceHistoryRow) => ({
    tradeDate: row.trade_date,
    closePrice: Number(row.close_price),
  }));
}
