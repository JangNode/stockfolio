import { NextRequest, NextResponse } from "next/server";
import {
  getDailyPrices,
  getIntradayBars,
  getOverseasDailyPrices,
  type ChartPeriod,
  type OverseasChartPeriod,
} from "@/lib/kis";
import { findOverseasByCode } from "@/lib/stockMasterOverseas";
import { requireApproved } from "@/lib/requireApproved";

const DAILY_PERIODS: ChartPeriod[] = ["D", "W", "M", "Y"];
const OVERSEAS_PERIODS: OverseasChartPeriod[] = ["D", "W", "M"];
const MINUTE_INTERVAL = 10;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  const denied = await requireApproved(request);
  if (denied) return denied;

  const { code } = await params;
  const market = request.nextUrl.searchParams.get("market") === "US" ? "US" : "KR";
  const periodParam = request.nextUrl.searchParams.get("period") ?? "D";

  if (market === "US") {
    // 해외 기간별시세는 일/주/월봉만 지원한다(분봉·년봉 대응 API가 없음) —
    // lib/kis.ts의 getOverseasDailyPrices 주석 참고. 화면에서도 미국 종목엔 해당
    // 옵션을 감추지만, 방어적으로 여기서도 막는다.
    if (!OVERSEAS_PERIODS.includes(periodParam as OverseasChartPeriod)) {
      return NextResponse.json(
        { error: "미국 종목은 period가 D, W, M 중 하나여야 합니다." },
        { status: 400 }
      );
    }

    try {
      const stock = await findOverseasByCode(code);
      if (!stock) {
        return NextResponse.json({ error: "존재하지 않는 종목코드입니다." }, { status: 404 });
      }
      const prices = await getOverseasDailyPrices(
        stock.exchange,
        stock.code,
        periodParam as OverseasChartPeriod
      );
      return NextResponse.json(prices);
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "알 수 없는 오류" },
        { status: 502 }
      );
    }
  }

  if (periodParam !== "min" && !DAILY_PERIODS.includes(periodParam as ChartPeriod)) {
    return NextResponse.json(
      { error: "period은 D, W, M, Y, min 중 하나여야 합니다." },
      { status: 400 }
    );
  }

  try {
    if (periodParam === "min") {
      const bars = await getIntradayBars(code, MINUTE_INTERVAL);
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
