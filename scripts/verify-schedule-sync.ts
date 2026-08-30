/**
 * 실행 중인 scripts/sync-rate-schedules.ts가 DB에 올바른 결과를 남겼는지, pg_cron에
 * 회의 날짜별 발표 집중 확인 잡이 실제로 등록됐는지 확인하는 1회성 검증 스크립트.
 * 확인 후 삭제한다.
 */
import { getFomcScheduleDates, getMpcScheduleDates } from "@/lib/scheduleStorage";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

async function main() {
  const fomc = await getFomcScheduleDates();
  const mpc = await getMpcScheduleDates();
  console.log(`FOMC 일정 ${fomc.length}건: ${JSON.stringify(fomc)}`);
  console.log(`MPC 일정 ${mpc.length}건: ${JSON.stringify(mpc)}`);

  const { data: status, error: statusError } = await supabaseAdmin
    .from("schedule_scrape_status")
    .select("*")
    .order("source");
  if (statusError) throw new Error(statusError.message);
  console.log(`schedule_scrape_status: ${JSON.stringify(status)}`);

  const { data: cronJobs, error: cronError } = await supabaseAdmin
    .schema("cron")
    .from("job")
    .select("jobname, schedule, command")
    .like("jobname", "trigger-fomc-2026%")
    .order("jobname");
  if (cronError) {
    console.log(`cron.job 조회 실패(PostgREST에서 cron 스키마 미노출일 수 있음, 무시 가능): ${cronError.message}`);
  } else {
    console.log(`FOMC 2026 관련 cron 잡: ${JSON.stringify(cronJobs)}`);
  }

  const { data: mpcCronJobs, error: mpcCronError } = await supabaseAdmin
    .schema("cron")
    .from("job")
    .select("jobname, schedule, command")
    .like("jobname", "trigger-mpc-2026%")
    .order("jobname");
  if (mpcCronError) {
    console.log(`cron.job 조회 실패(무시 가능): ${mpcCronError.message}`);
  } else {
    console.log(`MPC 2026 관련 cron 잡: ${JSON.stringify(mpcCronJobs)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
