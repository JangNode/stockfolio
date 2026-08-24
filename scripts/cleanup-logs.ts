/**
 * 로그성 배치 실행 기록(screening_runs, paper_runs)에서 finished_at이 오래된 행을
 * 삭제하는 정리 스크립트. 두 테이블 모두 "오늘 배치가 실행됐는지"만 확인하면 되는
 * 운영 로그라(components/Screening.tsx, components/PaperTrading.tsx 참고) 무제한
 * 보관할 이유가 없다 — DB 용량 최적화 조사(2026-08-24)에서 확인.
 *
 * 이 저장소의 다른 모든 정기 작업과 마찬가지로 pg_cron 같은 DB 내부 스케줄러 대신
 * GitHub Actions 워크플로에서 호출한다(.github/workflows/screening.yml 마지막 스텝) —
 * 이 프로젝트엔 pg_cron/Edge Function을 쓴 전례가 전혀 없고, 스크립트 기반 배치
 * 패턴(screen-all-stocks.ts, paper-trade.ts)이 이미 자리잡혀 있어 그대로 따르는 게
 * 일관적이다. 며칠 늦게 돌아도(스케줄 지연/드롭) 데이터가 조금 더 오래 남을 뿐 해가
 * 없는 작업이라, 다른 배치들처럼 별도 미실행 감지 Routine은 두지 않는다.
 *
 *   tsx --conditions=react-server scripts/cleanup-logs.ts
 *
 * 필요 환경변수: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";

const RETENTION_DAYS = 90;

async function deleteOldRows(table: "screening_runs" | "paper_runs"): Promise<number> {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabaseAdmin
    .from(table)
    .delete()
    .lt("finished_at", cutoff)
    .select("id");

  if (error) {
    throw new Error(`${table} 정리 실패: ${error.message}`);
  }

  return data?.length ?? 0;
}

async function main(): Promise<void> {
  console.log(`로그 정리 배치 시작: 보관 기간 ${RETENTION_DAYS}일`);

  const deletedScreeningRuns = await deleteOldRows("screening_runs");
  console.log(`screening_runs: ${deletedScreeningRuns}건 삭제`);

  const deletedPaperRuns = await deleteOldRows("paper_runs");
  console.log(`paper_runs: ${deletedPaperRuns}건 삭제`);

  console.log("로그 정리 배치 종료");
}

main().catch((error) => {
  console.error("로그 정리 배치 실행 중 오류가 발생했습니다:", error);
  process.exit(1);
});
