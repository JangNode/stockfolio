import "server-only";
import { getDailyPricesForStocksOnOrBefore } from "@/lib/stockDailyPricesStorage";
import { THEME_CONSTITUENTS_RETENTION_YEARS } from "@/lib/themeConfig";

/** 테마 등락률 API 라우트(app/api/themes/route.ts, app/api/themes/[code]/route.ts)가
 * 공유하는 계산 로직.
 *
 * 일간(오늘)만 예외로, scripts/screen-all-stocks.ts가 KIS 원값(전일대비등락율)을 그대로
 * 집계해 theme_daily_returns에 저장해둔 값을 쓴다(개별 종목 일간 등락률은 KIS API가
 * 직접 주는 값을 그대로 쓰고 재계산하지 않는다 — 호출부가 판단할 수 있도록
 * resolveThemePeriodRange가 isToday 플래그를 돌려준다).
 *
 * 그 외(과거 날짜의 일간, 월별, 년별)는 모두 "구간 시작 직전 거래일 종가" 대비
 * "구간 종료일(또는 오늘) 종가"로 통일해 계산한다 — 종목별로 계산한 뒤 테마 단순평균을
 * 낸다(시총가중 아님, 대형주 쏠림을 피하려는 기존 결정 유지). 필요한 종가를
 * scripts/backfill-theme-stock-prices.ts가 채운 stock_daily_prices_recent/Parquet에서
 * 못 찾으면(백필 범위 밖, 그 시점 상장 전 등) 그 종목은 계산에서 제외한다.
 */

export type ThemePeriod = "daily" | "monthly" | "yearly";

export function isThemePeriod(value: string | null): value is ThemePeriod {
  return value === "daily" || value === "monthly" || value === "yearly";
}

export interface ResolvedThemePeriodRange {
  // 그 기간의 달력상 시작일. 실제 기준가는 이 날짜 "이전"(포함 안 함) 가장 가까운
  // 거래일 종가를 쓴다(예: 월별이면 전월 말 종가, 년별이면 전년 말 종가).
  periodStartDate: string;
  // 그 기간의 종료 기준일. 실제 종료가는 이 날짜 "이전 포함" 가장 가까운 거래일
  // 종가를 쓴다(선택 기간이 오늘이 속한 달/올해면 오늘, 과거면 그 달/해의 마지막 날).
  referenceEndDate: string;
  // period가 daily이고 선택한 날짜가 오늘인 경우만 true — 이 경우 호출부는 이 파일의
  // 계산 대신 theme_daily_returns에 저장된 KIS 원값을 그대로 써야 한다.
  isToday: boolean;
}

function isValidIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(value + "T00:00:00Z").getTime());
}

function isValidYear(value: string): boolean {
  return /^\d{4}$/.test(value);
}

function isValidMonth(value: string): boolean {
  const n = Number(value);
  return /^\d{1,2}$/.test(value) && n >= 1 && n <= 12;
}

function padMonth(value: string): string {
  return value.padStart(2, "0");
}

/** year년 month월(1~12)의 마지막 날짜(YYYY-MM-DD). */
function lastDayOfMonth(year: string, month: string): string {
  const d = new Date(Date.UTC(Number(year), Number(month), 0));
  return d.toISOString().slice(0, 10);
}

export interface ThemePeriodParams {
  date?: string | null;
  year?: string | null;
  month?: string | null;
}

/** period + 쿼리파라미터를 "그 기간을 계산하는 데 필요한 날짜 범위"로 정규화한다.
 * 잘못되거나 없는 파라미터는 기본값(오늘/이번 달/올해)으로 대체한다. */
export function resolveThemePeriodRange(
  period: ThemePeriod,
  params: ThemePeriodParams,
  todayIsoDate: string
): ResolvedThemePeriodRange {
  if (period === "daily") {
    const date = params.date && isValidIsoDate(params.date) ? params.date : todayIsoDate;
    return { periodStartDate: date, referenceEndDate: date, isToday: date === todayIsoDate };
  }

  const todayYear = todayIsoDate.slice(0, 4);
  const todayMonth = todayIsoDate.slice(5, 7);

  if (period === "monthly") {
    const year = params.year && isValidYear(params.year) ? params.year : todayYear;
    const month = params.month && isValidMonth(params.month) ? padMonth(params.month) : todayMonth;
    const isCurrentMonth = year === todayYear && month === todayMonth;
    return {
      periodStartDate: `${year}-${month}-01`,
      referenceEndDate: isCurrentMonth ? todayIsoDate : lastDayOfMonth(year, month),
      isToday: false,
    };
  }

  // yearly
  const year = params.year && isValidYear(params.year) ? params.year : todayYear;
  const isCurrentYear = year === todayYear;
  return {
    periodStartDate: `${year}-01-01`,
    referenceEndDate: isCurrentYear ? todayIsoDate : `${year}-12-31`,
    isToday: false,
  };
}

/** 선택 가능한 최소 날짜(YYYY-MM-DD). scripts/backfill-theme-stock-prices.ts가
 * THEME_CONSTITUENTS_RETENTION_YEARS(lib/themeConfig.ts)년치를 채워두는데, 그 시작일
 * 바로 근처는 "구간 시작 직전 거래일"(기준가)을 못 찾을 수 있어 여유를 하루 이상
 * 둔다. */
const MIN_DATE_BUFFER_DAYS = 7;

export function themeDataMinDate(todayIsoDate: string): string {
  const d = new Date(todayIsoDate + "T00:00:00Z");
  d.setUTCFullYear(d.getUTCFullYear() - THEME_CONSTITUENTS_RETENTION_YEARS);
  d.setUTCDate(d.getUTCDate() + MIN_DATE_BUFFER_DAYS);
  return d.toISOString().slice(0, 10);
}

/** range가 백필된 데이터 범위 안에 있는지 확인한다. 벗어나면(백필 시작일 이전으로
 * 거슬러 올라가거나, 오늘 이후를 요청한 경우) 계산을 시도하지 않고 "데이터 없음"으로
 * 처리해야 한다. */
export function isThemePeriodRangeAvailable(range: ResolvedThemePeriodRange, todayIsoDate: string): boolean {
  return range.periodStartDate >= themeDataMinDate(todayIsoDate) && range.referenceEndDate <= todayIsoDate;
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** stockCodes 각각의 range 기간 등락률(%)을 계산한다. 시작/종료 기준가를 배치로
 * 한 번씩만 조회하므로(lib/stockDailyPricesStorage.ts의
 * getDailyPricesForStocksOnOrBefore) 종목 수와 무관하게 쿼리 횟수가 일정하다. 시작/종료
 * 둘 다 종가를 찾은 종목만 결과에 포함한다.
 *
 * periodStartDate === referenceEndDate(즉 daily 기간)일 때만 종료가를 그 날짜 그대로
 * 정확히 맞춘다(maxLookbackDays=0, 폴백 없음) — stock_daily_prices_recent는 KRX 정산
 * 데이터를 "오늘"은 빼고 다음 영업일 배치가 채우므로, 방금 지난 거래일의 데이터가
 * 아직 안 채워졌을 수 있다. 이때 폴백을 허용하면 시작가(baselineDate)도 같은 이전
 * 날짜로 떨어져 등락률이 우연히 0%로 계산된다("데이터 없음"이어야 정확함 —
 * 2026-09-01 테마 등락률 전부 0.00%로 표시된 버그의 원인). 월별/년별은
 * referenceEndDate가 달력상 월말/년말이라 주말·공휴일일 수 있어 폴백이 그대로
 * 필요하다. */
export async function computeStockReturnsForPeriod(
  stockCodes: string[],
  range: ResolvedThemePeriodRange
): Promise<Map<string, number>> {
  if (stockCodes.length === 0) return new Map();

  const isSingleDay = range.periodStartDate === range.referenceEndDate;
  const baselineDate = addDays(range.periodStartDate, -1);
  const [startPrices, endPrices] = await Promise.all([
    getDailyPricesForStocksOnOrBefore(stockCodes, baselineDate),
    isSingleDay
      ? getDailyPricesForStocksOnOrBefore(stockCodes, range.referenceEndDate, 0)
      : getDailyPricesForStocksOnOrBefore(stockCodes, range.referenceEndDate),
  ]);

  const result = new Map<string, number>();
  for (const code of stockCodes) {
    const start = startPrices.get(code);
    const end = endPrices.get(code);
    if (!start || !end || start.closePrice === 0) continue;
    result.set(code, ((end.closePrice - start.closePrice) / start.closePrice) * 100);
  }
  return result;
}

/** 종목별 등락률(%) 맵의 단순평균(%). 하나도 없으면 null("데이터 없음"). */
export function averageReturnPct(returns: Map<string, number>): number | null {
  if (returns.size === 0) return null;
  let sum = 0;
  for (const v of returns.values()) sum += v;
  return sum / returns.size;
}
