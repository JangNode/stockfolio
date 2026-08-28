import { NextRequest, NextResponse } from "next/server";
import { getStockPrice, getProfitRatioYears, getDividendRecords } from "@/lib/kis";
import { requireApproved } from "@/lib/requireApproved";
import { computeEpsCagrAsOf } from "@/lib/stockFundamentals";
import { computePeg } from "@/lib/pegRatio";

const DIVIDEND_YEARS_TO_SHOW = 5;

function yyyymmddDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

function todayKstIsoDate(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
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
    const [price, profitRatioYears, dividendRecords, epsCagr] = await Promise.all([
      getStockPrice(code),
      getProfitRatioYears(code),
      getDividendRecords(code, DIVIDEND_YEARS_TO_SHOW),
      // PEG = PER ÷ 최근 5년 EPS 성장률. PER은 위 KIS 실시간 값을 그대로 분모로 쓰고
      // (이 카드가 이미 그 PER을 보여주고 있어서), 성장률만 DART 연간 재무(point-in-time)
      // 기반으로 계산한다 — DART 후보종목 데이터가 없는 소형주는 null(카드엔 "-")로
      // 자연스럽게 빠진다.
      computeEpsCagrAsOf(code, todayKstIsoDate()),
    ]);
    const latestRoePct = profitRatioYears[0]?.roePct ?? null;
    const pegRatio = computePeg(price.per, epsCagr?.growthPct ?? null);

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

    // 배당수익률/1년간 배당 횟수(상단 스탯)는 한투 앱 자체 정의를 그대로 따른다 —
    // "배당수익률 = 최근 1년 주당배당금 합계 / 전일 종가", "1년간 배당 = 지급일
    // 기준으로 최근 1년동안 지급된 배당지급 횟수"(한투 앱 툴팁 원문). 즉 기준일이
    // 아니라 지급일(payDate) 기준 롤링 365일이고, 아직 지급 전인(payDate가 미래인)
    // 예정 배당 건은 제외해야 한다 — 처음엔 이 구분 없이 recordDate만 써서 아직
    // 지급 안 된 예정 배당까지 포함시키는 바람에 한투보다 값이 더 크게 나왔다(005930
    // 실측으로 확인). 위 5개년 표(dividends)는 달력연도 기준 합산이라 그대로 두고,
    // 이 두 값만 별도로 계산한다.
    const oneYearAgo = yyyymmddDaysAgo(365);
    const today = yyyymmddDaysAgo(0);
    const paidLastYear = dividendRecords.filter(
      (r) => r.payDate !== null && r.payDate <= today && r.payDate >= oneYearAgo
    );
    const dividendCountLastYear = paidLastYear.length;
    const paidLastYearTotal = paidLastYear.reduce((sum, r) => sum + r.cashDividendPerShare, 0);
    const dividendYieldPct = price.currentPrice > 0 ? (paidLastYearTotal / price.currentPrice) * 100 : null;

    return NextResponse.json({
      dividends,
      currentPrice: price.currentPrice,
      per: price.per,
      pbr: price.pbr,
      peg: pegRatio,
      epsGrowthPct: epsCagr?.growthPct ?? null,
      roePct: latestRoePct,
      dividendYieldPct,
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
