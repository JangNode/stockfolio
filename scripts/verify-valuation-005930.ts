/**
 * (임시) EPS/BPS 최종 반영 확인용 읽기 전용 스크립트 — 005930(삼성전자) 기준.
 *
 * PR #94(EPS = DART 공시 기본주당이익, BPS/ROE 분모 = 지배기업 소유주지분)를 적용한
 * 배치(run 33033100453)가 끝난 뒤, dart_financial_statement_years에 실제로 반영된
 * 값을 확인하고 현재가 기준 PER/PBR을 계산해 한투 앱 표시값(PER 40.68/PBR 4.17/
 * EPS 6,564원/ROE 10.85%)과 비교한다. 확인 후 삭제 예정.
 *
 *   tsx --conditions=react-server scripts/verify-valuation-005930.ts
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getStockPrice } from "@/lib/kis";

async function main(): Promise<void> {
  const { data: rows, error } = await supabaseAdmin
    .from("dart_financial_statement_years")
    .select("bsns_year, eps, bps, roe_pct, controlling_net_income, is_final")
    .eq("stock_code", "005930")
    .order("bsns_year", { ascending: false })
    .limit(3);

  if (error) throw new Error(`조회 실패: ${error.message}`);

  console.log("=== dart_financial_statement_years (005930, 최근 3개년) ===");
  console.log(JSON.stringify(rows, null, 2));

  const latest = rows?.[0];
  if (!latest) {
    console.log("행이 없습니다.");
    return;
  }

  const price = await getStockPrice("005930");
  console.log(`\n현재가: ${price.currentPrice}`);

  const per = latest.eps && latest.eps > 0 ? price.currentPrice / latest.eps : null;
  const pbr = latest.bps && latest.bps > 0 ? price.currentPrice / latest.bps : null;

  console.log("\n=== 계산 결과 ===");
  console.log(`EPS: ${latest.eps} (한투 표시값: 6,564원)`);
  console.log(`BPS: ${latest.bps} (기대값 약 72,807원 = 424,313,255,000,000 / 5,827,808,935)`);
  console.log(`ROE: ${latest.roe_pct}% (한투 표시값: 10.85%)`);
  console.log(`PER: ${per} (한투 표시값: 40.68)`);
  console.log(`PBR: ${pbr} (한투 표시값: 4.17)`);
}

main().catch((error) => {
  console.error("확인 중 오류:", error);
  process.exit(1);
});
