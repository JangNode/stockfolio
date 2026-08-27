import { NextRequest, NextResponse } from "next/server";
import { getIncomeStatementYears, getBalanceSheetYears, getProfitRatioYears, getGrowthRatioYears } from "@/lib/kis";
import { requireApproved } from "@/lib/requireApproved";

interface FinancialStatementYear {
  year: number;
  revenue: number | null;
  operatingIncome: number | null;
  netIncome: number | null;
  totalAssets: number | null;
  totalLiabilities: number | null;
  totalEquity: number | null;
  revenueGrowthPct: number | null;
  operatingIncomeGrowthPct: number | null;
  netIncomeGrowthPct: number | null;
  operatingMarginPct: number | null;
  netMarginPct: number | null;
}

const YEARS_TO_SHOW = 3;

function ratioPct(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || denominator === 0) return null;
  return (numerator / denominator) * 100;
}

// KIS는 국내(KRX) 상장사만 다루므로 미국 종목은 지원 대상이 아니다 — 프런트에서도
// market === "KR"일 때만 이 엔드포인트를 호출한다.
export async function GET(request: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const denied = await requireApproved(request);
  if (denied) return denied;

  const { code } = await params;

  try {
    const [income, balance, profit, growth] = await Promise.all([
      getIncomeStatementYears(code),
      getBalanceSheetYears(code),
      getProfitRatioYears(code),
      getGrowthRatioYears(code),
    ]);

    const incomeByYear = new Map(income.map((y) => [y.year, y]));
    const balanceByYear = new Map(balance.map((y) => [y.year, y]));
    const profitByYear = new Map(profit.map((y) => [y.year, y]));
    const growthByYear = new Map(growth.map((y) => [y.year, y]));

    // 당기순이익 증감률은 KIS 성장성비율 API에 없어 손익계산서 연도별 값으로 직접
    // 계산한다(YoY). 비교 대상 전년도가 income 배열에 없으면(가장 오래된 연도) null.
    const years: FinancialStatementYear[] = income.slice(0, YEARS_TO_SHOW).map((y) => {
      const prevNetIncome = incomeByYear.get(y.year - 1)?.netIncome ?? null;
      const netIncomeGrowthPct =
        prevNetIncome !== null && prevNetIncome !== 0 && y.netIncome !== null
          ? ((y.netIncome - prevNetIncome) / Math.abs(prevNetIncome)) * 100
          : null;

      return {
        year: y.year,
        revenue: y.revenue,
        operatingIncome: y.operatingIncome,
        netIncome: y.netIncome,
        totalAssets: balanceByYear.get(y.year)?.totalAssets ?? null,
        totalLiabilities: balanceByYear.get(y.year)?.totalLiabilities ?? null,
        totalEquity: balanceByYear.get(y.year)?.totalEquity ?? null,
        revenueGrowthPct: growthByYear.get(y.year)?.revenueGrowthPct ?? null,
        operatingIncomeGrowthPct: growthByYear.get(y.year)?.operatingIncomeGrowthPct ?? null,
        netIncomeGrowthPct,
        operatingMarginPct: ratioPct(y.operatingIncome, y.revenue),
        netMarginPct: profitByYear.get(y.year)?.netMarginPct ?? null,
      };
    });

    return NextResponse.json({ years: years.reverse() });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "알 수 없는 오류" },
      { status: 502 }
    );
  }
}
