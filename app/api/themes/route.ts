import { NextResponse } from "next/server";
import { requireApproved } from "@/lib/requireApproved";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { THEME_CODES, THEME_LABELS, type ThemeCode } from "@/lib/themeConfig";
import { compoundChangeRatesPct, isThemePeriod, themePeriodStartDate, type ThemePeriod } from "@/lib/themeReturns";

function todayKstIsoDate(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

interface ThemeReturnRow {
  trade_date: string;
  theme_code: string;
  change_rate_pct: number;
  constituent_count: number;
}

/** scripts/screen-all-stocks.ts가 매일 채워 넣는 테마별 일간 등락률(theme_daily_returns)을
 * 기간(daily/monthly/yearly)에 맞게 복리로 누적해 테마 순위로 내려준다. */
export async function GET(request: Request) {
  const denied = await requireApproved(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const periodParam = url.searchParams.get("period");
  const period: ThemePeriod = isThemePeriod(periodParam) ? periodParam : "daily";

  try {
    const today = todayKstIsoDate();
    const startDate = themePeriodStartDate(period, today);

    const { data, error } = await supabaseAdmin
      .from("theme_daily_returns")
      .select("trade_date, theme_code, change_rate_pct, constituent_count")
      .gte("trade_date", startDate)
      .lte("trade_date", today)
      .order("trade_date", { ascending: true });

    if (error) throw new Error(`테마 등락률 조회 실패: ${error.message}`);

    const rowsByTheme = new Map<string, ThemeReturnRow[]>();
    for (const row of (data ?? []) as ThemeReturnRow[]) {
      const list = rowsByTheme.get(row.theme_code) ?? [];
      list.push(row);
      rowsByTheme.set(row.theme_code, list);
    }

    const themes = THEME_CODES.filter((code) => (rowsByTheme.get(code)?.length ?? 0) > 0).map((code) => {
      const rows = rowsByTheme.get(code)!;
      const latest = rows[rows.length - 1];
      return {
        themeCode: code,
        label: THEME_LABELS[code as ThemeCode],
        changeRatePct: compoundChangeRatesPct(rows.map((r) => r.change_rate_pct)),
        constituentCount: latest.constituent_count,
      };
    });

    themes.sort((a, b) => b.changeRatePct - a.changeRatePct);

    return NextResponse.json({ period, asOfDate: today, themes });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "알 수 없는 오류" },
      { status: 502 }
    );
  }
}
