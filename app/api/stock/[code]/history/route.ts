import { NextRequest, NextResponse } from "next/server";
import { getDailyPrices, type ChartPeriod } from "@/lib/kis";

const VALID_PERIODS: ChartPeriod[] = ["D", "W", "M"];

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;
  const periodParam = request.nextUrl.searchParams.get("period") ?? "D";

  if (!VALID_PERIODS.includes(periodParam as ChartPeriod)) {
    return NextResponse.json(
      { error: "period은 D, W, M 중 하나여야 합니다." },
      { status: 400 }
    );
  }

  try {
    const prices = await getDailyPrices(code, periodParam as ChartPeriod);
    return NextResponse.json(prices);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "알 수 없는 오류" },
      { status: 502 }
    );
  }
}
