import { NextResponse } from "next/server";
import { requireApproved } from "@/lib/requireApproved";
import { getUsFedRateHistory, getKrBaseRateHistory } from "@/lib/rateStorage";
import { FOMC_SCHEDULE, MPC_SCHEDULE } from "@/lib/rateScheduleConfig";

function todayKstIsoDate(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

/** 미국/한국 기준금리 변경점 이력 + 다가오는 FOMC/금통위 일정을 내려준다. "지난 회의
 * 결과"(인상/인하/동결, 변동폭)는 화면에서 이 변경점 이력 자체로부터 계산한다 —
 * lib/rateScheduleConfig.ts는 올해(2026) 일정만 갖고 있어 과거 회의와 정확히 1:1
 * 매칭시킬 수 없지만, 변경점 이력은 항상 정확하다. */
export async function GET(request: Request) {
  const denied = await requireApproved(request);
  if (denied) return denied;

  try {
    const [us, kr] = await Promise.all([getUsFedRateHistory(), getKrBaseRateHistory()]);

    const today = todayKstIsoDate();
    const upcoming = [
      ...FOMC_SCHEDULE.map((s) => ({ market: "US" as const, date: s.date })),
      ...MPC_SCHEDULE.map((s) => ({ market: "KR" as const, date: s.date })),
    ]
      .filter((s) => s.date >= today)
      .sort((a, b) => a.date.localeCompare(b.date));

    return NextResponse.json({ us, kr, upcoming });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "알 수 없는 오류" },
      { status: 502 }
    );
  }
}
