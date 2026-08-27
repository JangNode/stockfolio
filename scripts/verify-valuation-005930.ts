/**
 * (임시) 지배주주순이익/유통주식수 기준 PER/PBR 재계산 검증용 읽기 전용 스크립트.
 * 삼성전자(005930) 하나를 예시로 캐싱된 controlling_net_income/shares_outstanding
 * 원본값과 그걸로 계산된 EPS/PER/PBR을 출력한다. DB/코드를 건드리지 않는다 —
 * 확인 끝나면 삭제.
 *
 *   tsx --conditions=react-server scripts/verify-valuation-005930.ts
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getStockPrice } from "@/lib/kis";

const STOCK_CODE = "005930";

async function main(): Promise<void> {
  console.log(`=== ${STOCK_CODE} 캐싱된 dart_financial_statement_years 원본값 ===`);
  const { data: rows, error } = await supabaseAdmin
    .from("dart_financial_statement_years")
    .select("*")
    .eq("stock_code", STOCK_CODE)
    .order("year", { ascending: true });

  if (error) throw new Error(`조회 실패: ${error.message}`);
  console.log(JSON.stringify(rows, null, 2));

  const latest = (rows ?? [])[((rows ?? []).length || 1) - 1];
  if (!latest) {
    console.log("캐싱된 행이 없습니다.");
    return;
  }

  console.log("\n=== 현재 KIS 시세 및 계산된 PER/PBR (지배주주순이익 + 유통주식수 기준) ===");
  const price = await getStockPrice(STOCK_CODE);
  console.log(`현재가: ${price.currentPrice}`);
  console.log(`전체 당기순이익(net_income): ${latest.net_income}`);
  console.log(`지배주주순이익(controlling_net_income): ${latest.controlling_net_income}`);
  console.log(`상장주식수(shares_outstanding): ${latest.shares_outstanding}`);
  console.log(`EPS(캐싱, 지배주주순이익 기준이면 반영됨): ${latest.eps}`);
  console.log(`BPS(캐싱): ${latest.bps}`);
  console.log(`PER = 현재가/EPS = ${latest.eps ? price.currentPrice / latest.eps : null}`);
  console.log(`PBR = 현재가/BPS = ${latest.bps ? price.currentPrice / latest.bps : null}`);

  const naiveEpsFromFullNetIncome = latest.shares_outstanding ? latest.net_income / latest.shares_outstanding : null;
  console.log(
    `\n(참고) 전체 당기순이익 기준이었다면 EPS = ${naiveEpsFromFullNetIncome}, PER = ${
      naiveEpsFromFullNetIncome ? price.currentPrice / naiveEpsFromFullNetIncome : null
    }`
  );
}

main().catch((error) => {
  console.error("검증 스크립트 실행 중 오류:", error);
  process.exit(1);
});
