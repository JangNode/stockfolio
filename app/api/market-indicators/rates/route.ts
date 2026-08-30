import { NextResponse } from "next/server";
import { requireApproved } from "@/lib/requireApproved";
import { getUsFedRateHistory, getKrBaseRateHistory } from "@/lib/rateStorage";
import { getFomcScheduleDates, getMpcScheduleDates } from "@/lib/scheduleStorage";

function todayKstIsoDate(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

/** 미국/한국 기준금리 변경점 이력 + FOMC/금통위 일정을 함께 내려준다. 일정은
 * scripts/sync-rate-schedules.ts가 매주 연준·한은 공식 페이지에서 자동 수집해
 * DB(fomc_meeting_schedule/mpc_meeting_schedule)에 채워둔 걸 그대로 읽는다 —
 * "지난 회의 결과"(인상/인하/동결)와 "다가오는 일정" 모두 이 데이터를 쓴다. */
export async function GET(request: Request) {
  const denied = await requireApproved(request);
  if (denied) return denied;

  try {
    const [us, kr, usSchedule, krSchedule] = await Promise.all([
      getUsFedRateHistory(),
      getKrBaseRateHistory(),
      getFomcScheduleDates(),
      getMpcScheduleDates(),
    ]);

    const today = todayKstIsoDate();
    const upcoming = [
      ...usSchedule.map((date) => ({ market: "US" as const, date })),
      ...krSchedule.map((date) => ({ market: "KR" as const, date })),
    ]
      .filter((s) => s.date >= today)
      .sort((a, b) => a.date.localeCompare(b.date));

    return NextResponse.json({ us, kr, usSchedule, krSchedule, upcoming });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "알 수 없는 오류" },
      { status: 502 }
    );
  }
}
