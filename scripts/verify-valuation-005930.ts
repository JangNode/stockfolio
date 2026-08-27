/**
 * (임시) 최종 검증용 읽기 전용 스크립트. 삼성전자(005930) 최신 캐싱값과 그걸로
 * 계산된 PER/PBR을 출력한다. DB/코드를 건드리지 않는다 — 확인 끝나면 삭제.
 *
 *   tsx --conditions=react-server scripts/verify-valuation-005930.ts
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getStockPrice } from "@/lib/kis";

const STOCK_CODE = "005930";

async function main(): Promise<void> {
  const { data: rows, error } = await supabaseAdmin
    .from("dart_financial_statement_years")
    .select("year, net_income, controlling_net_income, shares_outstanding, eps, bps, is_final")
    .eq("stock_code", STOCK_CODE)
    .order("year", { ascending: true });

  if (error) throw new Error(`조회 실패: ${error.message}`);
  console.log(JSON.stringify(rows, null, 2));

  const latest = (rows ?? [])[((rows ?? []).length || 1) - 1];
  if (!latest) return;

  const price = await getStockPrice(STOCK_CODE);
  console.log(`\n현재가: ${price.currentPrice}`);
  console.log(`PER = ${latest.eps ? price.currentPrice / latest.eps : null}`);
  console.log(`PBR = ${latest.bps ? price.currentPrice / latest.bps : null}`);
}

main().catch((error) => {
  console.error("검증 스크립트 실행 중 오류:", error);
  process.exit(1);
});
