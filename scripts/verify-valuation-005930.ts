/**
 * (임시) 오늘(KST) 스크리닝/AI 모의투자 배치 실행 여부 확인용 읽기 전용 스크립트.
 * screening_runs/paper_runs 테이블에서 오늘 날짜(KST) 행을 그대로 조회한다.
 * DB는 읽기만 한다 — 확인 후 삭제 예정.
 *
 *   tsx --conditions=react-server scripts/verify-valuation-005930.ts
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";

function todayKst(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

async function main(): Promise<void> {
  const today = todayKst();
  console.log(`오늘(KST): ${today}`);

  const { data: screeningRuns, error: screeningError } = await supabaseAdmin
    .from("screening_runs")
    .select("*")
    .order("finished_at", { ascending: false })
    .limit(10);
  if (screeningError) throw new Error(`screening_runs 조회 실패: ${screeningError.message}`);
  console.log("\n=== screening_runs 최근 10건 ===");
  console.log(JSON.stringify(screeningRuns, null, 2));

  const { data: paperRuns, error: paperError } = await supabaseAdmin
    .from("paper_runs")
    .select("*")
    .order("finished_at", { ascending: false })
    .limit(10);
  if (paperError) throw new Error(`paper_runs 조회 실패: ${paperError.message}`);
  console.log("\n=== paper_runs 최근 10건 ===");
  console.log(JSON.stringify(paperRuns, null, 2));
}

main().catch((error) => {
  console.error("확인 중 오류:", error);
  process.exit(1);
});
