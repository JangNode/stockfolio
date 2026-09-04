import "server-only";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

/**
 * 종목별 업종 분류(stock_industry_classification) 접근. DART company.json(기업개황)의
 * induty_code를 분기 1회(scripts/backfill-stock-industry-classification.ts) 채우고,
 * scripts/calc-industry-average-per.ts와 valuation API 라우트가 읽는다.
 */

const TABLE = "stock_industry_classification";

export interface StockIndustryRow {
  stockCode: string;
  corpCode: string;
  indutyCode: string | null;
  indutyGroup: string | null;
}

interface StockIndustryDbRow {
  stock_code: string;
  corp_code: string;
  induty_code: string | null;
  induty_group: string | null;
}

export async function getStockIndustry(stockCode: string): Promise<StockIndustryRow | null> {
  const { data, error } = await supabaseAdmin
    .from(TABLE)
    .select("stock_code, corp_code, induty_code, induty_group")
    .eq("stock_code", stockCode)
    .maybeSingle();
  if (error) throw new Error(`${stockCode} 업종 분류 조회 실패: ${error.message}`);
  if (!data) return null;
  const row = data as StockIndustryDbRow;
  return { stockCode: row.stock_code, corpCode: row.corp_code, indutyCode: row.induty_code, indutyGroup: row.induty_group };
}

export async function upsertStockIndustryClassifications(rows: StockIndustryRow[]): Promise<void> {
  if (rows.length === 0) return;
  const { error } = await supabaseAdmin.from(TABLE).upsert(
    rows.map((r) => ({
      stock_code: r.stockCode,
      corp_code: r.corpCode,
      induty_code: r.indutyCode,
      induty_group: r.indutyGroup,
      updated_at: new Date().toISOString(),
    }))
  );
  if (error) throw new Error(`업종 분류 저장 실패: ${error.message}`);
}

/** 저장된 업종 분류 전체를 조회한다 — 업종 평균 PER 계산 배치가 그룹핑에 쓴다. */
export async function getAllStockIndustryClassifications(): Promise<StockIndustryRow[]> {
  const rows: StockIndustryRow[] = [];
  let from = 0;
  const PAGE = 1000;
  for (;;) {
    const { data, error } = await supabaseAdmin
      .from(TABLE)
      .select("stock_code, corp_code, induty_code, induty_group")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`업종 분류 전체 조회 실패: ${error.message}`);
    for (const row of (data ?? []) as StockIndustryDbRow[]) {
      rows.push({ stockCode: row.stock_code, corpCode: row.corp_code, indutyCode: row.induty_code, indutyGroup: row.induty_group });
    }
    if (!data || data.length < PAGE) break;
    from += PAGE;
  }
  return rows;
}
