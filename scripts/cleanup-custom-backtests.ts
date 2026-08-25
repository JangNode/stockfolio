/**
 * 실험실 탭 커스텀 백테스트(custom_backtest_runs) 중 30일이 지났고 채택되지 않은
 * (adopted_at이 null인) 결과를 정리하는 스크립트. 채택된 결과는 AI 모의투자 커스텀
 * 슬롯의 근거로 계속 참조될 수 있으므로 제외한다. DB 행뿐 아니라 결과 원본이 저장된
 * Supabase Storage 객체(lib/customBacktestStorage.ts)도 함께 지운다 — 결과가 클수록
 * DB 용량 최적화 취지가 무의미해지기 때문.
 *
 * scripts/cleanup-logs.ts와 같은 이유로 pg_cron/Edge Function 대신 GitHub Actions
 * 워크플로에서 호출한다(.github/workflows/screening.yml 마지막 스텝) — 이 저장소엔
 * DB 내부 스케줄러를 쓴 전례가 없고, 스크립트 기반 배치 패턴이 이미 자리잡혀 있다.
 *
 *   tsx --conditions=react-server scripts/cleanup-custom-backtests.ts
 *
 * 필요 환경변수: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { deleteCustomBacktestResult } from "@/lib/customBacktestStorage";

const RETENTION_DAYS = 30;

interface StaleRun {
  id: string;
  result_storage_path: string | null;
}

async function main(): Promise<void> {
  console.log(`실험실 백테스트 정리 배치 시작: 보관 기간 ${RETENTION_DAYS}일(미채택 결과만)`);

  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabaseAdmin
    .from("custom_backtest_runs")
    .select("id, result_storage_path")
    .is("adopted_at", null)
    .lt("created_at", cutoff);

  if (error) throw new Error(`정리 대상 조회 실패: ${error.message}`);

  const staleRuns = (data ?? []) as StaleRun[];
  if (staleRuns.length === 0) {
    console.log("정리할 대상이 없습니다.");
    return;
  }

  console.log(`정리 대상 ${staleRuns.length}건`);

  let storageDeleted = 0;
  let storageErrors = 0;

  for (const run of staleRuns) {
    if (!run.result_storage_path) continue;
    try {
      await deleteCustomBacktestResult(run.result_storage_path);
      storageDeleted++;
    } catch (storageError) {
      storageErrors++;
      const message = storageError instanceof Error ? storageError.message : String(storageError);
      console.error(`  ${run.id} Storage 객체 삭제 실패, DB 행은 계속 정리합니다: ${message}`);
    }
  }

  const { error: deleteError } = await supabaseAdmin
    .from("custom_backtest_runs")
    .delete()
    .in(
      "id",
      staleRuns.map((r) => r.id)
    );
  if (deleteError) throw new Error(`custom_backtest_runs 정리 실패: ${deleteError.message}`);

  console.log(
    `실험실 백테스트 정리 배치 종료: 행 ${staleRuns.length}건 삭제(Storage 객체 ${storageDeleted}건 삭제, ` +
      `실패 ${storageErrors}건)`
  );
}

main().catch((error) => {
  console.error("실험실 백테스트 정리 배치 실행 중 오류가 발생했습니다:", error);
  process.exit(1);
});
