import { NextRequest, NextResponse } from "next/server";
import { getDailyPrices, getIntradayBars, type ChartPeriod } from "@/lib/kis";

const DAILY_PERIODS: ChartPeriod[] = ["D", "W", "M", "Y"];
const VALID_MINUTE_INTERVALS = [1, 3, 5, 10, 15, 30, 60];
const DEFAULT_MINUTE_INTERVAL = 10;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;
  const periodParam = request.nextUrl.searchParams.get("period") ?? "D";

  if (periodParam !== "min" && !DAILY_PERIODS.includes(periodParam as ChartPeriod)) {
    return NextResponse.json(
      { error: "period은 D, W, M, Y, min 중 하나여야 합니다." },
      { status: 400 }
    );
  }

  try {
    if (periodParam === "min") {
      const intervalParam = Number(
        request.nextUrl.searchParams.get("interval") ?? DEFAULT_MINUTE_INTERVAL
      );
      const interval = VALID_MINUTE_INTERVALS.includes(intervalParam)
        ? intervalParam
        : DEFAULT_MINUTE_INTERVAL;

      const bars = await getIntradayBars(code, interval);
      return NextResponse.json(bars);
    }

    const prices = await getDailyPrices(code, periodParam as ChartPeriod);
    return NextResponse.json(prices);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "알 수 없는 오류" },
      { status: 502 }
    );
  }
}
