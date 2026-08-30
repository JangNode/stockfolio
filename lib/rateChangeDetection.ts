/**
 * 기준금리 시계열에서 "값이 실제로 바뀐 지점"만 뽑아내는 순수 계산부. 미국(상단/하단
 * 2개 값)과 한국(단일 1개 값)이 값을 숫자 배열로만 표현하면 공용으로 재사용할 수 있게
 * 해, FOMC/금통위 발표 감지 로직(scripts/check-rate-announcement.ts)이 시장별로
 * 따로 만들 필요가 없게 한다.
 */

export interface RatePoint {
  effectiveDate: string; // YYYY-MM-DD
  values: number[]; // 미국: [상단, 하단], 한국: [기준금리] 하나
}

function valuesEqual(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** 날짜 오름차순 시계열(매일 값이 그대로 반복돼도 됨)에서 값이 바뀐 지점만 뽑는다.
 * 첫 지점은 항상 포함된다(그 이전 값을 알 수 없어 "바뀜"으로 취급). */
export function computeChangePoints(series: RatePoint[]): RatePoint[] {
  const result: RatePoint[] = [];
  for (const point of series) {
    const prev = result[result.length - 1];
    if (!prev || !valuesEqual(prev.values, point.values)) {
      result.push(point);
    }
  }
  return result;
}

/** 저장돼 있던 가장 최근 변경점과 새로 계산한 가장 최근 변경점을 비교해 실제로
 * 바뀌었는지 판정한다. FOMC/금통위 발표 감지 재시도 루프가 "이번 확인에서 값이
 * 바뀌었는가"를 판정하는 데 공용으로 쓴다. */
export function hasLatestChanged(previous: RatePoint | null, current: RatePoint | null): boolean {
  if (!current) return false;
  if (!previous) return true;
  return previous.effectiveDate !== current.effectiveDate || !valuesEqual(previous.values, current.values);
}

/** 변경점 배열(effectiveDate 오름차순)에서 asOfDate 시점에 적용 중이던 값을 고른다
 * (그 날짜 이하의 가장 최근 변경점). "회의 결과" 화면이 특정 회의 날짜에 실제로
 * 적용된 값을 찾는 데 쓴다 — 변경점 저장소에는 값이 안 바뀐 회의(동결)의 행이 아예
 * 없으므로, 회의 일정 날짜를 그대로 넣어도 "그 날 기준 적용 중이던 값"을 정확히
 * 돌려준다. */
export function pickValueAsOf<T extends { effectiveDate: string }>(points: T[], asOfDate: string): T | null {
  let picked: T | null = null;
  for (const p of points) {
    if (p.effectiveDate > asOfDate) break;
    picked = p;
  }
  return picked;
}

/** pickValueAsOf와 같지만 asOfDate 당일은 제외하고 그 이전(strictly before) 값만
 * 고른다 — "이 회의 직전까지 적용되고 있던 값"을 구해 이번 회의 결과와 비교하는 데
 * 쓴다. */
export function pickValueBefore<T extends { effectiveDate: string }>(points: T[], date: string): T | null {
  let picked: T | null = null;
  for (const p of points) {
    if (p.effectiveDate >= date) break;
    picked = p;
  }
  return picked;
}

/** 저장된 변경점의 날짜 + 알려진 회의 일정 날짜(오늘 이하만)를 합쳐, "회의 결과"
 * 목록에 쓸 날짜 집합을 만든다. 변경점 날짜만 쓰면 "동결"로 끝난 회의가 아예
 * 빠지므로(값이 안 바뀐 날은 애초에 저장되지 않음), 일정에 있는 과거 회의 날짜를
 * 반드시 함께 포함해야 한다. */
export function buildMeetingResultDates<T extends { effectiveDate: string }>(
  points: T[],
  scheduleDates: string[],
  todayDate: string
): string[] {
  const dates = new Set<string>();
  for (const p of points) dates.add(p.effectiveDate);
  for (const d of scheduleDates) {
    if (d <= todayDate) dates.add(d);
  }
  return Array.from(dates).sort((a, b) => a.localeCompare(b));
}
