import { NextResponse } from "next/server";
import { getMarketSummary } from "@/lib/kis";

export async function GET() {
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
