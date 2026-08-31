/** 테마 등락률 API 라우트(app/api/themes/route.ts, app/api/themes/[code]/route.ts)가
 * 공유하는 순수 계산 로직. theme_daily_returns에는 일별 등락률만 저장돼 있고,
 * 월별/년도별 등락률은 조회 시점에 일별 값을 복리로 누적해 계산한다(저장하지 않음).
 */

export type ThemePeriod = "daily" | "monthly" | "yearly";

export function isThemePeriod(value: string | null): value is ThemePeriod {
  return value === "daily" || value === "monthly" || value === "yearly";
}

/** period에 해당하는 조회 시작일(YYYY-MM-DD)을 구한다. "월별"은 이번 달 1일부터,
 * "년도별"은 올해 1월 1일부터 오늘까지의 누적이다(최근 N개월/N년 롤링 윈도가 아니라
 * 달력 기준 월/년이다). */
export function themePeriodStartDate(period: ThemePeriod, todayIsoDate: string): string {
  const [year, month] = todayIsoDate.split("-");
  if (period === "daily") return todayIsoDate;
  if (period === "monthly") return `${year}-${month}-01`;
  return `${year}-01-01`;
}

/** 일별 등락률(%, 예: 1.23은 +1.23%)을 복리로 누적한다: (1+r1)*(1+r2)*...*(1+rn)-1.
 * 입력 순서는 날짜 오름차순이어야 한다(순서가 달라도 곱셈이라 결과 값 자체는 같지만,
 * 호출부 실수를 줄이기 위해 오름차순을 전제로 한다). */
export function compoundChangeRatesPct(dailyChangeRatesPct: number[]): number {
  const compounded = dailyChangeRatesPct.reduce((acc, r) => acc * (1 + r / 100), 1);
  return (compounded - 1) * 100;
}
