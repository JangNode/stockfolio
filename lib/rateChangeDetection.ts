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
