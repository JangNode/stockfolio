import { NextRequest, NextResponse } from "next/server";
import { getStockPrice, getProfitRatioYears, getDividendRecords } from "@/lib/kis";
import { requireApproved } from "@/lib/requireApproved";

const DIVIDEND_YEARS_TO_SHOW = 5;

function yyyymmddDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

// KIS는 국내(KRX) 상장사만 다루므로 미국 종목은 지원 대상이 아니다 — 프런트에서도
// market === "KR"일 때만 이 엔드포인트를 호출한다.
export async function GET(request: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const denied = await requireApproved(request);
  if (denied) return denied;

  const { code } = await params;

  try {
    // PER/PBR/EPS/BPS/상장주식수/52주 최고·최저가는 KIS 현재가 조회 API가 이미 내려주는
    // 값을 그대로 쓴다 — DART 재무제표를 재조합해 직접 계산하던 이전 방식과 달리
    // 한국투자증권 앱 표시값과 실측 비교해 일치함을 확인했다(005930 기준). ROE는 이
    // API에 없어 수익성비율 API(연도별)의 최근 연도 값을 쓴다.
    const [price, profitRatioYears, dividendRecords] = await Promise.all([
      getStockPrice(code),
      getProfitRatioYears(code),
      getDividendRecords(code, DIVIDEND_YEARS_TO_SHOW),
    ]);
    const latestRoePct = profitRatioYears[0]?.roePct ?? null;

    // 배당수익률/배당성향은 오늘 주가·오늘 EPS 기준 스냅샷이라 캐싱하지 않는다.
    // 5개년 표의 과거 연도 배당수익률도 동일하게 "오늘 주가로 계산했다면"의 값으로
    // 통일해 보여준다(연도별 당시 주가 조회는 별도 호출이 더 필요해 생략) — 값 자체는
    // 그 해에 지급된 실제 배당금이므로 절대 배당금은 정확하다.
    const totalsByYear = new Map<number, number>();
    for (const r of dividendRecords) {
      const year = Number(r.recordDate.slice(0, 4));
      totalsByYear.set(year, (totalsByYear.get(year) ?? 0) + r.cashDividendPerShare);
    }
    const dividends = Array.from(totalsByYear.entries())
      .sort((a, b) => b[0] - a[0])
      .map(([year, cashDividendPerShareCommon]) => ({
        year,
        cashDividendPerShareCommon,
        dividendYieldPct: price.currentPrice > 0 ? (cashDividendPerShareCommon / price.currentPrice) * 100 : null,
      }));

    const latestDividend = dividends[0] ?? null;
    const payoutRatioPct =
      latestDividend !== null && price.eps !== null && price.eps > 0
        ? (latestDividend.cashDividendPerShareCommon / price.eps) * 100
        : null;

    // "1년간 배당 횟수" — 오늘부터 최근 365일(롤린 윈도우, 달력연도 아님) 안에 지급된
    // 배당 이벤트 건수. 위 5개년 합산과 같은 응답(dividendRecords)을 그대로 재사용해
    // API를 추가로 부르지 않는다.
    const oneYearAgo = yyyymmddDaysAgo(365);
    const dividendCountLastYear = dividendRecords.filter((r) => r.recordDate >= oneYearAgo).length;

    return NextResponse.json({
      dividends,
      currentPrice: price.currentPrice,
      per: price.per,
      pbr: price.pbr,
      roePct: latestRoePct,
      dividendYieldPct: latestDividend?.dividendYieldPct ?? null,
      payoutRatioPct,
      marketCapEok: price.marketCapEok,
      sharesOutstanding: price.sharesOutstanding,
      eps: price.eps,
      week52High: price.week52High,
      week52Low: price.week52Low,
      dividendCountLastYear,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "알 수 없는 오류" },
      { status: 502 }
    );
  }
}
