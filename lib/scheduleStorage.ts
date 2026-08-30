import "server-only";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import type { ScrapedMeeting } from "@/lib/scheduleValidation";

export async function getFomcScheduleDates(): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from("fomc_meeting_schedule")
    .select("meeting_date")
    .order("meeting_date", { ascending: true });
  if (error) throw new Error(`FOMC 일정 조회 실패: ${error.message}`);
  return (data ?? []).map((r) => r.meeting_date);
}

export async function getMpcScheduleDates(): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from("mpc_meeting_schedule")
    .select("meeting_date")
    .order("meeting_date", { ascending: true });
  if (error) throw new Error(`금통위 일정 조회 실패: ${error.message}`);
  return (data ?? []).map((r) => r.meeting_date);
}

/** 스크래핑이 검증까지 통과했을 때만 호출된다 — 해당 소스의 일정 전체를
 * 새 결과로 교체해, 취소·재조정 같은 정당한 변경도 그대로 반영되게 한다. */
export async function replaceFomcSchedule(meetings: ScrapedMeeting[]): Promise<void> {
  const { error: deleteError } = await supabaseAdmin
    .from("fomc_meeting_schedule")
    .delete()
    .gte("meeting_date", "1900-01-01");
  if (deleteError) throw new Error(`FOMC 일정 삭제 실패: ${deleteError.message}`);
  if (meetings.length === 0) return;
  const { error } = await supabaseAdmin
    .from("fomc_meeting_schedule")
    .insert(meetings.map((m) => ({ meeting_date: m.date, year: m.year, source_label: m.sourceLabel })));
  if (error) throw new Error(`FOMC 일정 저장 실패: ${error.message}`);
}

export async function replaceMpcSchedule(meetings: ScrapedMeeting[]): Promise<void> {
  const { error: deleteError } = await supabaseAdmin
    .from("mpc_meeting_schedule")
    .delete()
    .gte("meeting_date", "1900-01-01");
  if (deleteError) throw new Error(`금통위 일정 삭제 실패: ${deleteError.message}`);
  if (meetings.length === 0) return;
  const { error } = await supabaseAdmin
    .from("mpc_meeting_schedule")
    .insert(meetings.map((m) => ({ meeting_date: m.date, year: m.year, source_label: m.sourceLabel })));
  if (error) throw new Error(`금통위 일정 저장 실패: ${error.message}`);
}

/** 수집 시도마다 성공/실패를 남긴다 — last_success_at을 보면 오래 갱신 안 됐는지
 * 바로 확인할 수 있고, 실패해도 last_error만 갱신할 뿐 일정 테이블은 건드리지
 * 않는다(기존 값 유지). */
export async function recordScheduleScrapeAttempt(
  source: "FOMC" | "MPC",
  errorMessage: string | null,
  meetingCount: number | null
): Promise<void> {
  const now = new Date().toISOString();
  const update: Record<string, unknown> = { source, last_attempt_at: now };
  if (errorMessage) {
    update.last_error = errorMessage;
  } else {
    update.last_error = null;
    update.last_success_at = now;
    update.last_meeting_count = meetingCount;
  }
  const { error } = await supabaseAdmin.from("schedule_scrape_status").upsert(update);
  if (error) throw new Error(`일정 수집 상태 기록 실패: ${error.message}`);
}
