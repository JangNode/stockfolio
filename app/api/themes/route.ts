import { NextResponse } from "next/server";
import { requireApproved } from "@/lib/requireApproved";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { THEME_CODES, THEME_LABELS, type ThemeCode } from "@/lib/themeConfig";
import { getStockCodesByTheme } from "@/lib/stockMaster";
import {
  averageReturnPct,
  computeStockReturnsForPeriod,
  isThemePeriod,
  isThemePeriodRangeAvailable,
  resolveThemePeriodRange,
  themeDataMinDate,
  type ResolvedThemePeriodRange,
  type ThemePeriod,
} from "@/lib/themeReturns";

function todayKstIsoDate(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

interface ThemeRankingItem {
  themeCode: ThemeCode;
  label: string;
  changeRatePct: number | null;
  constituentCount: number;
  insufficientData: boolean;
}

interface StoredThemeRow {
  theme_code: string;
  change_rate_pct: number;
  constituent_count: number;
}

/** scripts/screen-all-stocks.ts가 KIS 원값(전일대비등락율)을 그대로 집계해둔
 * theme_daily_returns를 특정 날짜 기준으로 읽는다 — 해당 날짜 행이 하나도 없으면
 * null을 반환해 호출부가 재계산 경로로 폴백하게 한다. */
async function fetchStoredThemeRankings(date: string): Promise<ThemeRankingItem[] | null> {
  const { data, error } = await supabaseAdmin
    .from("theme_daily_returns")
    .select("theme_code, change_rate_pct, constituent_count")
    .eq("trade_date", date);

  if (error) throw new Error(`저장된 테마 등락률 조회 실패: ${error.message}`);
  if (!data || data.length === 0) return null;

  const rowsByTheme = new Map((data as StoredThemeRow[]).map((r) => [r.theme_code, r]));

  return THEME_CODES.map((code) => {
    const row = rowsByTheme.get(code);
    return {
      themeCode: code,
      label: THEME_LABELS[code],
      changeRatePct: row ? row.change_rate_pct : null,
      constituentCount: row ? row.constituent_count : 0,
      insufficientData: !row,
    };
  });
}

/** 과거 날짜(일별)/월별/년별 테마 순위. 테마별 구성종목(오늘 기준 근사, lib/stockMaster.ts)
 * 전체의 종가를 한 번에 배치 조회(computeStockReturnsForPeriod)한 뒤 테마별로
 * 나눠 단순평균을 낸다 — 12개 테마를 순회할 때마다 다시 조회하지 않는다. */
async function fetchComputedThemeRankings(range: ResolvedThemePeriodRange): Promise<ThemeRankingItem[]> {
  const codesByTheme = await getStockCodesByTheme();
  const allCodes = Array.from(new Set(THEME_CODES.flatMap((code) => codesByTheme[code])));
  const returns = await computeStockReturnsForPeriod(allCodes, range);

  return THEME_CODES.map((code) => {
    const themeReturns = new Map(
      codesByTheme[code].filter((c) => returns.has(c)).map((c) => [c, returns.get(c)!])
    );
    const changeRatePct = averageReturnPct(themeReturns);
    return {
      themeCode: code,
      label: THEME_LABELS[code],
      changeRatePct,
      constituentCount: themeReturns.size,
      insufficientData: changeRatePct === null,
    };
  });
}

function outOfRangeThemes(): ThemeRankingItem[] {
  return THEME_CODES.map((code) => ({
    themeCode: code,
    label: THEME_LABELS[code],
    changeRatePct: null,
    constituentCount: 0,
    insufficientData: true,
  }));
}

/** scripts/screen-all-stocks.ts가 매일 채워 넣는 테마별 등락률(theme_daily_returns)을
 * daily 기간에서는 항상 우선 조회하고, 저장된 행이 없을 때만(오래된 날짜 등)
 * lib/themeReturns.ts의 재계산 경로로 폴백한다. 월별/년별은 일자별 저장이 없어
 * 항상 재계산한다. */
export async function GET(request: Request) {
  const denied = await requireApproved(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const periodParam = url.searchParams.get("period");
  const period: ThemePeriod = isThemePeriod(periodParam) ? periodParam : "daily";
  const today = todayKstIsoDate();
  const range = resolveThemePeriodRange(
    period,
    {
      date: url.searchParams.get("date"),
      year: url.searchParams.get("year"),
      month: url.searchParams.get("month"),
    },
    today
  );

  try {
    const outOfRange = !range.isToday && !isThemePeriodRangeAvailable(range, today);

    const themes = range.isToday
      ? (await fetchStoredThemeRankings(today)) ?? outOfRangeThemes()
      : outOfRange
        ? outOfRangeThemes()
        : period === "daily"
          ? (await fetchStoredThemeRankings(range.referenceEndDate)) ?? (await fetchComputedThemeRankings(range))
          : await fetchComputedThemeRankings(range);

    themes.sort((a, b) => {
      if (a.changeRatePct === null) return 1;
      if (b.changeRatePct === null) return -1;
      return b.changeRatePct - a.changeRatePct;
    });

    return NextResponse.json({
      period,
      asOfDate: range.referenceEndDate,
      dataAvailableFrom: themeDataMinDate(today),
      insufficientData: outOfRange,
      ...(outOfRange ? { message: "해당 기간 데이터가 없습니다." } : {}),
      themes,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "알 수 없는 오류" },
      { status: 502 }
    );
  }
}
