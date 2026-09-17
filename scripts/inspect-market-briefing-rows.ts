/**
 * "Cowork 브리핑 날짜 어긋남" 문제(사용자 보고: date_kst=2026-09-16로 저장된 행이
 * 실제로는 9/17 아침 내용) 처리 방안을 정하기 전, market_briefings 테이블의 최근
 * 며칠치 실제 상태를 확인하는 디스포저블 읽기 전용 스크립트. DB에 아무것도 쓰지
 * 않는다. 확인 후 삭제 예정.
 *   npx tsx --conditions=react-server scripts/inspect-market-briefing-rows.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function main(): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from("market_briefings")
    .select("id, date_kst, created_at, raw_json")
    .order("date_kst", { ascending: true });

  if (error) throw new Error(`조회 실패: ${error.message}`);
  if (!data || data.length === 0) {
    console.log("market_briefings 테이블에 행이 없습니다.");
    return;
  }

  console.log(`총 ${data.length}건\n`);

  for (const row of data) {
    const raw = asRecord(row.raw_json);
    const reportDate = raw?.report_date ?? "(없음)";
    const conclusion = raw?.conclusion ?? raw?.summary ?? null;
    const conclusionPreview =
      typeof conclusion === "string" ? conclusion.slice(0, 200) : JSON.stringify(conclusion)?.slice(0, 200);

    console.log(`--- id=${row.id} ---`);
    console.log(`date_kst(DB)      : ${row.date_kst}`);
    console.log(`created_at(DB)    : ${row.created_at}`);
    console.log(`report_date(JSON) : ${reportDate}`);
    console.log(`conclusion/summary 미리보기: ${conclusionPreview ?? "(없음)"}`);
    console.log();
  }
}

main().catch((error) => {
  console.error("조회 스크립트 실행 중 오류:", error);
  process.exit(1);
});
