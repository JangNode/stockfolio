import { NextRequest, NextResponse } from "next/server";
import { requireApproved } from "@/lib/requireApproved";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { isThemeCode, THEME_LABELS, type ThemeCode } from "@/lib/themeConfig";
import { getAllStocks, getStockCodesByTheme } from "@/lib/stockMaster";
import {
  computeStockReturnsForPeriod,
  isThemePeriod,
  isThemePeriodRangeAvailable,
  resolveThemePeriodRange,
  themeDataMinDate,
  type ThemePeriod,
} from "@/lib/themeReturns";

function todayKstIsoDate(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

interface StoredConstituent {
  code: string;
  name: string;
  changeRate: number;
}

interface StoredThemeRow {
  constituents: StoredConstituent[];
}

interface Constituent {
  code: string;
  name: string;
  changeRatePct: number;
}

/** scripts/screen-all-stocks.ts가 KIS 원값(전일대비등락율)으로 이미 저장해둔 구성종목
 * 상세(theme_daily_returns.constituents)를 특정 날짜 기준으로 읽는다. 해당
 * (theme_code, trade_date) 행 자체가 없으면 null을 반환해 호출부가 재계산 경로로
 * 폴백하게 한다 — 행은 있지만 구성종목 상세가 비어있는 경우(오래된 날짜, 3년 경과 후
 * cleanupOldThemeConstituents가 정리함)는 빈 배열을 그대로 반환한다. */
async function fetchStoredConstituents(themeCode: ThemeCode, date: string): Promise<Constituent[] | null> {
  const { data, error } = await supabaseAdmin
    .from("theme_daily_returns")
    .select("constituents")
    .eq("theme_code", themeCode)
    .eq("trade_date", date)
    .maybeSingle();

  if (error) throw new Error(`저장된 테마 구성종목 조회 실패: ${error.message}`);
  const row = data as StoredThemeRow | null;
  if (!row) return null;
  return (row.constituents ?? []).map((c) => ({ code: c.code, name: c.name, changeRatePct: c.changeRate }));
}

/** 특정 테마의 기간별(daily/monthly/yearly) 구성종목 등락률 상세를 내려준다. daily는
 * theme_daily_returns에 저장된 행이 있으면 항상 그걸 우선 쓰고, 없을 때만(오래된
 * 날짜 등) 재계산 경로로 폴백한다. monthly/yearly는 일자별 저장이 없어 항상
 * 재계산하며, 계산 불가한(백필 범위 밖이거나 그 시점 상장 전인) 구성종목은 목록에서
 * 제외한다 — lib/themeReturns.ts 참고. */
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

  async function computeConstituents(): Promise<Constituent[]> {
    const [codesByTheme, allStocks] = await Promise.all([getStockCodesByTheme(), getAllStocks()]);
    const nameByCode = new Map(allStocks.map((s) => [s.code, s.name]));
    const returns = await computeStockReturnsForPeriod(codesByTheme[themeCode], range);

    return Array.from(returns.entries()).map(([stockCode, changeRatePct]) => ({
      code: stockCode,
      name: nameByCode.get(stockCode) ?? stockCode,
      changeRatePct,
    }));
  }

  try {
    let constituents: Constituent[];

    if (range.isToday) {
      constituents = (await fetchStoredConstituents(themeCode, today)) ?? [];
    } else if (!isThemePeriodRangeAvailable(range, today)) {
      constituents = [];
    } else if (period === "daily") {
      constituents = (await fetchStoredConstituents(themeCode, range.referenceEndDate)) ?? (await computeConstituents());
    } else {
      constituents = await computeConstituents();
    }

    constituents.sort((a, b) => b.changeRatePct - a.changeRatePct);

    const outOfRange = !range.isToday && !isThemePeriodRangeAvailable(range, today);

    return NextResponse.json({
      themeCode,
      label: THEME_LABELS[themeCode],
      period,
      asOfDate: range.referenceEndDate,
      dataAvailableFrom: themeDataMinDate(today),
      insufficientData: outOfRange || constituents.length === 0,
      ...(outOfRange ? { message: "해당 기간 데이터가 없습니다." } : {}),
      constituents,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "알 수 없는 오류" },
      { status: 502 }
    );
  }
}
