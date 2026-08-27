import { NextRequest, NextResponse } from "next/server";
import { getInvestorTrend } from "@/lib/kis";
import { requireApproved } from "@/lib/requireApproved";

// KIS는 국내(KRX) 상장사만 다루므로 미국 종목은 지원 대상이 아니다 — 프런트에서도
// market === "KR"일 때만 이 엔드포인트를 호출한다.
export async function GET(request: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const denied = await requireApproved(request);
  if (denied) return denied;

  const { code } = await params;

  try {
    const days = await getInvestorTrend(code);
    return NextResponse.json({ days });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "알 수 없는 오류" },
      { status: 502 }
    );
  }
}
