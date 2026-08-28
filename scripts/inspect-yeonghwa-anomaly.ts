/**
 * (1회성 진단) 영화금속(012280) screening_results 행이 "진입가 803원"으로 기록된
 * 것이 실제 오류(버그로 생성된 값)인지, 액면분할/병합 등 실제 사건 때문에
 * 수익률이 왜곡된 것인지 확인한다. 확인 후 삭제 예정.
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getStockPrice, getDailyPrices } from "@/lib/kis";

const CODE = "012280";

async function main(): Promise<void> {
  console.log(`=== screening_results (stock_code=${CODE}) ===`);
  const { data: rows, error } = await supabaseAdmin
    .from("screening_results")
    .select(
      "id, strategy_id, stock_code, stock_name, signal_price, entry_price, stop_loss_price, take_profit_price, current_price, return_pct, status, score, market, matched_at, closed_at"
    )
    .eq("stock_code", CODE)
    .order("matched_at", { ascending: true });
  if (error) throw new Error(`screening_results 조회 실패: ${error.message}`);
  console.log(JSON.stringify(rows, null, 2));

  if (rows && rows.length > 0) {
    const strategyIds = Array.from(new Set(rows.map((r) => r.strategy_id)));
    const { data: strategies, error: stratError } = await supabaseAdmin
      .from("strategies")
      .select("id, name, rule_type, rule_params, user_id")
      .in("id", strategyIds);
    if (stratError) throw new Error(`strategies 조회 실패: ${stratError.message}`);
    console.log("\n=== 연결된 strategies ===");
    console.log(JSON.stringify(strategies, null, 2));
  }

  console.log("\n=== 현재 KIS 실시간 시세 ===");
  const price = await getStockPrice(CODE);
  console.log(JSON.stringify(price, null, 2));

  console.log("\n=== 최근 일봉(최대 500건, 상장주식수 변화로 액면분할/병합 추정) ===");
  const daily = await getDailyPrices(CODE, "D", 500);
  console.log(`총 ${daily.length}건, 첫 날짜: ${daily[0]?.date}, 마지막 날짜: ${daily[daily.length - 1]?.date}`);
  // 종가가 하루 사이 3배 이상 튀는 지점(액면분할/병합 시 흔히 나타남)을 찾는다.
  for (let i = 1; i < daily.length; i++) {
    const prev = daily[i - 1].close;
    const cur = daily[i].close;
    if (prev > 0 && (cur / prev > 3 || prev / cur > 3)) {
      console.log(`  급변 지점: ${daily[i - 1].date}(${prev}) → ${daily[i].date}(${cur})`);
    }
  }
  console.log("최근 10건:", JSON.stringify(daily.slice(-10), null, 2));

  console.log("\n진단 완료.");
}

main().catch((error) => {
  console.error("진단 중 오류:", error);
  process.exit(1);
});
