import { NextRequest, NextResponse } from "next/server";
import { requireApproved } from "@/lib/requireApproved";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { isThemeCode, THEME_LABELS, type ThemeCode } from "@/lib/themeConfig";
import { compoundChangeRatesPct, isThemePeriod, themePeriodStartDate, type ThemePeriod } from "@/lib/themeReturns";

function todayKstIsoDate(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

interface Constituent {
  code: string;
  name: string;
  changeRate: number;
}

interface ThemeReturnRow {
  trade_date: string;
  constituents: Constituent[];
}

/** 특정 테마의 기간별(daily/monthly/yearly) 구성종목 등락률(복리 누적) 상세를 내려준다.
 * theme_daily_returns.constituents가 이미 3년 지나 비워진 구간(RULES.md 3번, DB
 * 용량 절약)은 개별 종목 상세를 재구성할 수 없다 — 하지만 daily/monthly/yearly 모두
 * 조회 범위가 최대 1년 안쪽이라 이 라우트에서는 그 경우를 만나지 않는다. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const denied = await requireApproved(request);
  if (denied) return denied;

  const { code } = await params;
  if (!isThemeCode(code)) {
    return NextResponse.json({ error: "존재하지 않는 테마입니다." }, { status: 404 });
  }
  const themeCode: ThemeCode = code;

  const url = new URL(request.url);
  const periodParam = url.searchParams.get("period");
  const period: ThemePeriod = isThemePeriod(periodParam) ? periodParam : "daily";

  try {
    const today = todayKstIsoDate();
    const startDate = themePeriodStartDate(period, today);

    const { data, error } = await supabaseAdmin
      .from("theme_daily_returns")
      .select("trade_date, constituents")
      .eq("theme_code", themeCode)
      .gte("trade_date", startDate)
      .lte("trade_date", today)
      .order("trade_date", { ascending: true });

    if (error) throw new Error(`테마 구성종목 조회 실패: ${error.message}`);

    const dailyRatesByCode = new Map<string, number[]>();
    const nameByCode = new Map<string, string>();

    for (const row of (data ?? []) as ThemeReturnRow[]) {
      for (const c of row.constituents) {
        const rates = dailyRatesByCode.get(c.code) ?? [];
        rates.push(c.changeRate);
        dailyRatesByCode.set(c.code, rates);
        nameByCode.set(c.code, c.name);
      }
    }

    const constituents = Array.from(dailyRatesByCode.entries())
      .map(([stockCode, rates]) => ({
        code: stockCode,
        name: nameByCode.get(stockCode) ?? stockCode,
        changeRatePct: compoundChangeRatesPct(rates),
      }))
      .sort((a, b) => b.changeRatePct - a.changeRatePct);

    return NextResponse.json({
      themeCode,
      label: THEME_LABELS[themeCode],
      period,
      asOfDate: today,
      constituents,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "알 수 없는 오류" },
      { status: 502 }
    );
  }
}
