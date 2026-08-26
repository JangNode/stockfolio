import { NextRequest, NextResponse } from "next/server";
import { getFinancialStatements, getDividendHistory } from "@/lib/dart";
import { getStockPrice } from "@/lib/kis";
import { requireApproved } from "@/lib/requireApproved";

// DART는 국내(KRX) 상장사만 다루므로 미국 종목은 지원 대상이 아니다 — 프런트에서도
// market === "KR"일 때만 이 엔드포인트를 호출한다.
export async function GET(request: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const denied = await requireApproved(request);
  if (denied) return denied;

  const { code } = await params;

  try {
    const [financials, dividends] = await Promise.all([getFinancialStatements(code), getDividendHistory(code)]);

    if (!financials || financials.length === 0) {
      return NextResponse.json({ financials: [], dividends: [], per: null, pbr: null, dividendYieldPct: null });
    }

    // PER/PBR/배당수익률은 "오늘 주가" 기준 스냅샷이라 캐싱하지 않는다 — 캐싱된
    // EPS/BPS/배당금(재료)에 지금 이 순간의 KIS 현재가를 조합해 즉시 계산한다.
    const price = await getStockPrice(code);
    const latest = financials[financials.length - 1];
    const latestDividend = dividends[0] ?? null;

    const per = latest.eps !== null && latest.eps > 0 ? price.currentPrice / latest.eps : null;
    const pbr = latest.bps !== null && latest.bps > 0 ? price.currentPrice / latest.bps : null;
    const dividendYieldPct =
      latestDividend?.cashDividendPerShareCommon !== null &&
      latestDividend?.cashDividendPerShareCommon !== undefined &&
      price.currentPrice > 0
        ? (latestDividend.cashDividendPerShareCommon / price.currentPrice) * 100
        : null;

    return NextResponse.json({
      financials,
      dividends,
      currentPrice: price.currentPrice,
      per,
      pbr,
      roePct: latest.roePct,
      dividendYieldPct,
      payoutRatioPct: latestDividend?.payoutRatioPct ?? null,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "알 수 없는 오류" },
      { status: 502 }
    );
  }
}
