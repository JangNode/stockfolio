import { NextResponse } from "next/server";
import { getMarketSummary } from "@/lib/kis";
import { requireApproved } from "@/lib/requireApproved";

export async function GET(request: Request) {
  const denied = await requireApproved(request);
  if (denied) return denied;

  try {
    const summary = await getMarketSummary();
    return NextResponse.json(summary);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "알 수 없는 오류" },
      { status: 502 }
    );
  }
}
