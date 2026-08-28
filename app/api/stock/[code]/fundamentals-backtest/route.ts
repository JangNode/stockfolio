import { NextRequest, NextResponse } from "next/server";
import { requireApproved } from "@/lib/requireApproved";
import { getDailyPriceSeries } from "@/lib/stockDailyPricesStorage";
import { loadFundamentalsSeriesWithListedShares } from "@/lib/stockFundamentals";
import type { DailyPrice } from "@/lib/backtest";

function todayKstIsoDate(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

/**
 * dh_value_dividend/peg_lynch 등 펀더멘털 기반 전략의 "전략 관리 > 백테스트" 화면
 * 조회 전용 엔드포인트. 이 전략들은 KIS 일봉이 아니라 DH 가격 레이어(종가/시가총액/
 * 상장주식수)와 point-in-time 재무 이력을 쓰므로, 기존 /api/stock/[code]/history와는
 * 별도 경로로 둔다 — 두 전략 모두 이동평균 등 기술 지표를 쓰지 않아 OHLC/거래량이
 * 필요 없으므로 DH 종가를 그대로 open/high/low/close에 채운다(scripts/screen-all-stocks.ts의
 * scanFundamentalStrategies와 동일한 변환). KR 전용(DART 재무는 국내 상장사만 다룸) —
 * 이 전략들 자체가 market="KR"로만 등록되므로 화면에서도 이 라우트를 그 조건일 때만 부른다.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const denied = await requireApproved(request);
  if (denied) return denied;

  const { code } = await params;
  const start = request.nextUrl.searchParams.get("start");
  if (!start) {
    return NextResponse.json({ error: "start 쿼리 파라미터(YYYY-MM-DD)가 필요합니다." }, { status: 400 });
  }
  const end = request.nextUrl.searchParams.get("end") ?? todayKstIsoDate();

  try {
    const [dhRows, fundamentalsData] = await Promise.all([
      getDailyPriceSeries(code, start, end),
      loadFundamentalsSeriesWithListedShares(code),
    ]);

    const prices: DailyPrice[] = dhRows.map((row) => ({
      date: row.tradeDate,
      open: row.closePrice,
      high: row.closePrice,
      low: row.closePrice,
      close: row.closePrice,
      volume: 0,
      marketCapEok: row.marketCapEok,
      listedShares: row.listedShares,
    }));

    return NextResponse.json({
      prices,
      fundamentals: fundamentalsData.series,
      // Map은 JSON으로 직렬화되지 않으므로 [fiscalYear, listedShares] 쌍 배열로 내려보내고,
      // 클라이언트에서 new Map(...)으로 되돌린다.
      listedSharesByFiscalYear: Array.from(fundamentalsData.listedSharesByFiscalYear.entries()),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "알 수 없는 오류" },
      { status: 502 }
    );
  }
}
