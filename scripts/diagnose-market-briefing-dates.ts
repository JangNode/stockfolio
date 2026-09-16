/**
 * "증시근황" 배치 진단용 디스포저블 스크립트. market_briefings 테이블에 실제로
 * 어떤 date_kst가 들어와 있는지 최근 10건 조회한다(읽기 전용, 아무것도 쓰지 않음).
 * 확인 후 삭제 예정.
 *   npx tsx --conditions=react-server scripts/diagnose-market-briefing-dates.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";

async function main(): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from("market_briefings")
    .select("date_kst, created_at")
    .order("date_kst", { ascending: false })
    .limit(10);

  if (error) throw new Error(`market_briefings 조회 실패: ${error.message}`);

  console.log(`market_briefings 최근 ${data?.length ?? 0}건 (date_kst 내림차순):`);
  for (const row of data ?? []) {
    console.log(`  date_kst=${row.date_kst}  created_at=${row.created_at}`);
  }

  const todayKst = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
  console.log(`\n현재 KST 날짜: ${todayKst}`);
}

main().catch((error) => {
  console.error("진단 스크립트 실행 중 오류:", error);
  process.exit(1);
});
