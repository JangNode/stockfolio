import { NextRequest, NextResponse } from "next/server";
import { getStockPrice, getOverseasDailyPrices } from "@/lib/kis";
import { findOverseasByCode } from "@/lib/stockMasterOverseas";
import { requireApproved } from "@/lib/requireApproved";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  const denied = await requireApproved(request);
  if (denied) return denied;

  const { code } = await params;
  const market = request.nextUrl.searchParams.get("market") === "US" ? "US" : "KR";

  try {
    if (market === "US") {
      const stock = await findOverseasByCode(code);
      if (!stock) {
        return NextResponse.json({ error: "존재하지 않는 종목코드입니다." }, { status: 404 });
      }

      // 해외 현재가 API(HHDFS00000300)엔 당일 시가/고가/저가가 없어, 일봉의 마지막
      // 봉(오늘)에서 그대로 뽑아 쓴다 — 직전 봉과 비교해 등락도 함께 계산한다.
      const daily = await getOverseasDailyPrices(stock.exchange, stock.code, "D", 2);
      if (daily.length === 0) {
        return NextResponse.json({ error: "시세 데이터가 없습니다." }, { status: 502 });
      }
      const today = daily[daily.length - 1];
      const prev = daily.length > 1 ? daily[daily.length - 2] : null;
      const change = prev ? today.close - prev.close : 0;
      const changeRate = prev && prev.close !== 0 ? (change / prev.close) * 100 : 0;

      return NextResponse.json({
        stockCode: stock.code,
        currentPrice: today.close,
        change,
        changeRate,
        openPrice: today.open,
        highPrice: today.high,
        lowPrice: today.low,
        volume: today.volume,
      });
    }

    const price = await getStockPrice(code);
    return NextResponse.json(price);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "알 수 없는 오류" },
      { status: 502 }
    );
  }
}
