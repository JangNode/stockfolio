import { NextResponse } from "next/server";
import { requireApproved } from "@/lib/requireApproved";
import { getKssStatus, listKssSignals, listKssTrack } from "@/lib/kodexSectorStorage";

// 화면은 최근 12개월 신호만 보여준다.
const RECENT_SIGNAL_LIMIT = 12;

/**
 * "전략 관리" 탭의 "KODEX 200 + 업종 모멘텀" 섹션이 읽는 라우트. 월간 배치
 * (scripts/kodex-sector-signal.ts)가 쌓은 신호·모의 추적 행과 마지막 실행 상태를 그대로 내려준다
 * (행 수가 작아 전부 읽는다). 시드 계산은 화면에서 lib/kodexSectorSatellite.ts로 한다.
 */
export async function GET(request: Request) {
  const denied = await requireApproved(request);
  if (denied) return denied;

  try {
    const [signals, track, status] = await Promise.all([listKssSignals(RECENT_SIGNAL_LIMIT), listKssTrack(), getKssStatus()]);
    return NextResponse.json({ signals, track, status });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
}
