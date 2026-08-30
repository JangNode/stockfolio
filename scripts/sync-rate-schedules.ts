/**
 * FOMC/금통위 회의 일정을 매주 한 번 공식 페이지에서 자동 수집해 DB에 반영하는
 * 배치. 파싱 실패 시 기존 저장된 일정은 그대로 두고 에러만 명확히 남긴다(절대
 * 덮어쓰지 않음) — 둘 중 하나라도 실패하면 워크플로 자체가 실패로 끝나 눈에 띄게
 * 한다. 성공하면 그 소스의 전체 일정을 최신 결과로 교체하고, 오늘 이후 회의
 * 날짜마다 FOMC/금통위 발표 집중 확인 cron(trigger_rate_check_dispatch, offsets
 * 0,5,15,30,60,120)을 register_meeting_backoff_cron RPC로 등록/갱신한다 — 더 이상
 * 회의가 확정될 때마다 수동으로 마이그레이션을 추가할 필요가 없다.
 *
 * 필요 환경변수: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   tsx --conditions=react-server scripts/sync-rate-schedules.ts
 */
import { scrapeFomcSchedule } from "@/lib/fomcScheduleScraper";
import { scrapeMpcSchedule } from "@/lib/mpcScheduleScraper";
import { validateYearlyMeetingCounts, type ScrapedMeeting } from "@/lib/scheduleValidation";
import { replaceFomcSchedule, replaceMpcSchedule, recordScheduleScrapeAttempt } from "@/lib/scheduleStorage";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

function todayKstIsoDate(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

function nthSundayOfMonthUtc(year: number, month1to12: number, n: number): Date {
  const first = new Date(Date.UTC(year, month1to12 - 1, 1));
  const firstSunday = 1 + ((7 - first.getUTCDay()) % 7);
  return new Date(Date.UTC(year, month1to12 - 1, firstSunday + (n - 1) * 7));
}

/** 미국 동부시간 서머타임(EDT) 여부 — 3월 둘째 일요일부터 11월 첫째 일요일까지.
 * 특정 연도에 하드코딩하지 않고 매년 계산해, FOMC 일정이 몇 년 앞서 올라와 있어도
 * (2026-08 기준 2027년치도 이미 공개) 그대로 맞는다. */
function isUsEasternDst(dateIso: string): boolean {
  const year = Number(dateIso.slice(0, 4));
  const dstStart = nthSundayOfMonthUtc(year, 3, 2);
  const dstEnd = nthSundayOfMonthUtc(year, 11, 1);
  const d = new Date(`${dateIso}T00:00:00Z`);
  return d >= dstStart && d < dstEnd;
}

/** FOMC 성명서 발표(미국 동부시간 14:00)를 UTC cron 표현식으로 변환한다. */
function fomcCronExpr(dateIso: string): string {
  const [, m, d] = dateIso.split("-").map(Number);
  const utcHour = isUsEasternDst(dateIso) ? 18 : 19; // EDT(UTC-4)=18시, EST(UTC-5)=19시
  return `0 ${utcHour} ${d} ${m} *`;
}

/** 금통위 발표(한국시간 09:00, 서머타임 없음)는 항상 UTC 00:00. */
function mpcCronExpr(dateIso: string): string {
  const [, m, d] = dateIso.split("-").map(Number);
  return `0 0 ${d} ${m} *`;
}

async function registerBackoffCron(jobName: string, cronExpr: string, market: "US" | "KR"): Promise<void> {
  const { error } = await supabaseAdmin.rpc("register_meeting_backoff_cron", {
    p_job_name: jobName,
    p_cron_expr: cronExpr,
    p_market: market,
  });
  if (error) throw new Error(`집중 확인 cron 등록 실패(${jobName}): ${error.message}`);
}

async function syncFomc(): Promise<boolean> {
  const currentYear = Number(todayKstIsoDate().slice(0, 4));
  let meetings: ScrapedMeeting[];
  try {
    meetings = await scrapeFomcSchedule();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[FOMC] 수집 실패: ${message}`);
    await recordScheduleScrapeAttempt("FOMC", message, null);
    return false;
  }

  const yearsToCheck = Array.from(new Set(meetings.map((m) => m.year))).filter(
    (y) => y >= currentYear - 1 && y <= currentYear + 2
  );
  const validationError = validateYearlyMeetingCounts(meetings, yearsToCheck, currentYear);
  if (validationError) {
    console.error(`[FOMC] 검증 실패: ${validationError} — 기존 일정을 그대로 유지합니다.`);
    await recordScheduleScrapeAttempt("FOMC", validationError, null);
    return false;
  }

  await replaceFomcSchedule(meetings);
  await recordScheduleScrapeAttempt("FOMC", null, meetings.length);
  console.log(`[FOMC] 수집 성공: 총 ${meetings.length}건`);

  const today = todayKstIsoDate();
  const upcoming = meetings.filter((m) => m.date >= today);
  for (const m of upcoming) {
    await registerBackoffCron(`trigger-fomc-${m.date}`, fomcCronExpr(m.date), "US");
  }
  console.log(`[FOMC] 집중 확인 cron ${upcoming.length}건 등록/갱신`);
  return true;
}

async function syncMpc(): Promise<boolean> {
  const currentYear = Number(todayKstIsoDate().slice(0, 4));
  const years = [currentYear - 1, currentYear, currentYear + 1];
  let meetings: ScrapedMeeting[];
  try {
    meetings = await scrapeMpcSchedule(years);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[MPC] 수집 실패: ${message}`);
    await recordScheduleScrapeAttempt("MPC", message, null);
    return false;
  }

  const validationError = validateYearlyMeetingCounts(meetings, years, currentYear);
  if (validationError) {
    console.error(`[MPC] 검증 실패: ${validationError} — 기존 일정을 그대로 유지합니다.`);
    await recordScheduleScrapeAttempt("MPC", validationError, null);
    return false;
  }

  await replaceMpcSchedule(meetings);
  await recordScheduleScrapeAttempt("MPC", null, meetings.length);
  console.log(`[MPC] 수집 성공: 총 ${meetings.length}건`);

  const today = todayKstIsoDate();
  const upcoming = meetings.filter((m) => m.date >= today);
  for (const m of upcoming) {
    await registerBackoffCron(`trigger-mpc-${m.date}`, mpcCronExpr(m.date), "KR");
  }
  console.log(`[MPC] 집중 확인 cron ${upcoming.length}건 등록/갱신`);
  return true;
}

async function main(): Promise<void> {
  const fomcOk = await syncFomc();
  const mpcOk = await syncMpc();
  if (!fomcOk || !mpcOk) {
    console.error("일정 동기화 중 하나 이상 실패했습니다 — 위 로그를 확인하세요.");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("일정 동기화 배치 중 예상치 못한 오류가 발생했습니다:", error);
  process.exit(1);
});
