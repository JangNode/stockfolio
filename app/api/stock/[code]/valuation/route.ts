import { NextRequest, NextResponse } from "next/server";
import { getStockPrice, getProfitRatioYears, getDividendYearTotals } from "@/lib/kis";
import { requireApproved } from "@/lib/requireApproved";

const DIVIDEND_YEARS_TO_SHOW = 5;

// KIS는 국내(KRX) 상장사만 다루므로 미국 종목은 지원 대상이 아니다 — 프런트에서도
// market === "KR"일 때만 이 엔드포인트를 호출한다.
export async function GET(request: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const denied = await requireApproved(request);
  if (denied) return denied;

  const { code } = await params;

  try {
    // PER/PBR/EPS/BPS는 KIS 현재가 조회 API가 이미 계산해서 내려주는 값을 그대로
    // 쓴다 — DART 재무제표를 재조합해 직접 계산하던 이전 방식과 달리 한국투자증권
    // 앱 표시값과 실측 비교해 일치함을 확인했다(005930 기준). ROE는 이 API에 없어
    // 수익성비율 API(연도별)의 최근 연도 값을 쓴다.
    const [price, profitRatioYears] = await Promise.all([getStockPrice(code), getProfitRatioYears(code)]);
    const latestRoePct = profitRatioYears[0]?.roePct ?? null;

    // 배당수익률/배당성향은 오늘 주가·오늘 EPS 기준 스냅샷이라 캐싱하지 않는다.
    // 5개년 표의 과거 연도 배당수익률도 동일하게 "오늘 주가로 계산했다면"의 값으로
    // 통일해 보여준다(연도별 당시 주가 조회는 별도 호출이 더 필요해 생략) — 값 자체는
    // 그 해에 지급된 실제 배당금이므로 절대 배당금은 정확하다.
    const dividendYears = await getDividendYearTotals(code, DIVIDEND_YEARS_TO_SHOW);
    const dividends = dividendYears.map((d) => ({
      year: d.year,
      cashDividendPerShareCommon: d.cashDividendPerShare,
      dividendYieldPct: price.currentPrice > 0 ? (d.cashDividendPerShare / price.currentPrice) * 100 : null,
    }));

    const latestDividend = dividends[0] ?? null;
    const payoutRatioPct =
      latestDividend !== null && price.eps !== null && price.eps > 0
        ? (latestDividend.cashDividendPerShareCommon / price.eps) * 100
        : null;

    return NextResponse.json({
      dividends,
      currentPrice: price.currentPrice,
      per: price.per,
      pbr: price.pbr,
      roePct: latestRoePct,
      dividendYieldPct: latestDividend?.dividendYieldPct ?? null,
      payoutRatioPct,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "알 수 없는 오류" },
      { status: 502 }
    );
  }
}
