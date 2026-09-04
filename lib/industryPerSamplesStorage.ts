import "server-only";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

/**
 * 업종 그룹별 종목 PER 원자료(stock_industry_per) 접근. 매일 1회
 * (scripts/calc-industry-average-per.ts)만 KIS를 호출해 종목별 PER을 저장하고,
 * valuation API 라우트는 이 표를 조회만 한다(추가 KIS 호출 없음).
 *
 * 업종 중앙값을 그룹 단위로 미리 계산해두지 않는 이유(2026-09-04, 삼성전자 사례로
 * 확인): 시총 비중이 압도적인 대형주는 자기 PER이 곧 그룹 전체(자기 포함) 중앙값과
 * 일치해버려 "업종과 비교"가 "자기 자신과 비교"가 된다. 그래서 종목별 원자료를
 * 그대로 저장해두고, 조회하는 쪽(lib/peerPerValuation.ts)이 요청 종목을 표본에서
 * 제외(leave-one-out)한 뒤 중앙값을 계산한다.
 */

const TABLE = "stock_industry_per";

export interface StockIndustryPerRow {
  stockCode: string;
  indutyGroup: string;
  per: number | null;
}

interface StockIndustryPerDbRow {
  stock_code: string;
  induty_group: string;
  per: number | string | null;
}

/** 같은 업종그룹의 PER 표본을 전부 가져온다(요청 종목 자신도 포함) — leave-one-out
 * 제외는 호출부의 몫이다. */
export async function getIndustryPerSamples(indutyGroup: string): Promise<StockIndustryPerRow[]> {
  const { data, error } = await supabaseAdmin.from(TABLE).select("stock_code, induty_group, per").eq("induty_group", indutyGroup);
  if (error) throw new Error(`${indutyGroup} 업종 PER 표본 조회 실패: ${error.message}`);
  return (data as StockIndustryPerDbRow[]).map((row) => ({
    stockCode: row.stock_code,
    indutyGroup: row.induty_group,
    per: row.per === null ? null : Number(row.per),
  }));
}

export async function upsertStockIndustryPers(rows: StockIndustryPerRow[]): Promise<void> {
  if (rows.length === 0) return;
  const { error } = await supabaseAdmin.from(TABLE).upsert(
    rows.map((r) => ({
      stock_code: r.stockCode,
      induty_group: r.indutyGroup,
      per: r.per,
      computed_at: new Date().toISOString(),
    }))
  );
  if (error) throw new Error(`업종 PER 표본 저장 실패: ${error.message}`);
}
