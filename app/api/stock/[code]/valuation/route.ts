import { NextRequest, NextResponse } from "next/server";
import { getStockPrice, getProfitRatioYears, getDividendRecords } from "@/lib/kis";
import { requireApproved } from "@/lib/requireApproved";
import { computeEpsCagrAsOf } from "@/lib/stockFundamentals";
import { computePeg } from "@/lib/pegRatio";
import { getEcosSeries } from "@/lib/ecosClient";
import { getStockBeta } from "@/lib/stockBetaStorage";
import { computeRequiredReturnPct } from "@/lib/capm";
import { computeRimFairValue } from "@/lib/rimValuation";
import { getStockIndustry } from "@/lib/industryClassificationStorage";
import { getIndustryPerSamples } from "@/lib/industryPerSamplesStorage";
import { computePeerPerFairValue } from "@/lib/peerPerValuation";
import { getCashflowStatements, getDebtStructure } from "@/lib/dartCashflowDebtStorage";
import { computeDcfFairValue } from "@/lib/dcfValuation";
import type { FairValueResult } from "@/lib/stockFairValue";

const DIVIDEND_YEARS_TO_SHOW = 5;
// ECOS 국고채 10년물(무위험이자율)은 캐싱 없이 매 요청 실시간 조회한다(사용자 확정,
// 2026-09-04) — 최근 이 구간(일) 안의 최신 관측치를 쓴다. 휴장일이 껴도 30일이면
// 충분히 관측치가 있다.
const ECOS_RISK_FREE_LOOKBACK_DAYS = 30;

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

    // 베타/무위험이자율/CAPM 요구수익률은 RIM과 DCF가 공유한다(중복 계산 금지).
    let betaRow: Awaited<ReturnType<typeof getStockBeta>> = null;
    let riskFreeRatePct: number | null = null;
    let requiredReturnPct: number | null = null;
    try {
      const [b, riskFreeSeries] = await Promise.all([
        getStockBeta(code),
        getEcosSeries("817Y002", "010210000", yyyymmddDaysAgo(ECOS_RISK_FREE_LOOKBACK_DAYS), today),
      ]);
      betaRow = b;
      riskFreeRatePct = riskFreeSeries.length > 0 ? riskFreeSeries[riskFreeSeries.length - 1].value : null;
      if (betaRow?.beta != null && riskFreeRatePct !== null) {
        requiredReturnPct = computeRequiredReturnPct(riskFreeRatePct, betaRow.beta);
      }
    } catch (error) {
      console.error(`${code} 베타/무위험이자율 조회 실패: ${error instanceof Error ? error.message : String(error)}`);
      // null 유지 — RIM/DCF 둘 다 자체 가드로 "산출 불가" 처리됨
    }

    // RIM(잔여이익모델)/방법A(업종 평균 PER)/DCF(현금흐름할인법)는 각각 독립적으로
    // 실패해도 위에서 이미 구한 PER/PBR/배당 데이터는 정상 응답하게 각자 try/catch로
    // 감싼다.
    let rim: FairValueResult;
    try {
      // 배당성향 = 최근 완료된 달력연도 배당 합계 ÷ 오늘 EPS(0~1 클램프). 배당 이력이
      // 없으면(totalsByYear에 그 연도가 없으면) 0으로 취급한다.
      const completedYear = Number(todayKstIsoDate().slice(0, 4)) - 1;
      const completedYearDividendTotal = totalsByYear.get(completedYear) ?? 0;
      const payoutRatio =
        price.eps !== null && price.eps > 0
          ? Math.min(1, Math.max(0, completedYearDividendTotal / price.eps))
          : 0;

      rim = computeRimFairValue({
        currentPrice: price.currentPrice,
        currentBps: price.bps,
        latestRoePct,
        beta: betaRow?.beta ?? null,
        riskFreeRatePct,
        payoutRatio,
      });
    } catch (error) {
      console.error(`${code} RIM 계산 실패: ${error instanceof Error ? error.message : String(error)}`);
      rim = { method: "RIM", fairPrice: null, gapPercent: null, verdict: "UNKNOWN", reason: "일시적 오류로 산출 실패" };
    }

    let dcf: FairValueResult;
    try {
      const [cashflowRows, debtRows] = await Promise.all([getCashflowStatements(code), getDebtStructure(code)]);
      dcf = computeDcfFairValue({
        currentPrice: price.currentPrice,
        sharesOutstanding: price.sharesOutstanding,
        marketCapEok: price.marketCapEok,
        cashflowRows,
        debtRows,
        beta: betaRow?.beta ?? null,
        riskFreeRatePct,
        requiredReturnPct,
      });
    } catch (error) {
      console.error(`${code} DCF 계산 실패: ${error instanceof Error ? error.message : String(error)}`);
      dcf = { method: "DCF", fairPrice: null, gapPercent: null, verdict: "UNKNOWN", reason: "일시적 오류로 산출 실패" };
    }

    let peerPer: FairValueResult;
    try {
      const industryRow = await getStockIndustry(code);
      const indutyGroup = industryRow?.indutyGroup ?? null;
      const groupSamples = indutyGroup ? await getIndustryPerSamples(indutyGroup) : [];

      peerPer = computePeerPerFairValue({
        currentPrice: price.currentPrice,
        eps: price.eps,
        stockCode: code,
        indutyGroup,
        groupSamples,
      });
    } catch (error) {
      console.error(`${code} 업종 평균 PER 계산 실패: ${error instanceof Error ? error.message : String(error)}`);
      peerPer = { method: "PEER_PER", fairPrice: null, gapPercent: null, verdict: "UNKNOWN", reason: "일시적 오류로 산출 실패" };
    }

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
      rim,
      peerPer,
      dcf,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "알 수 없는 오류" },
      { status: 502 }
    );
  }
}
