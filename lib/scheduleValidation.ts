/**
 * FOMC/금통위 일정 스크래핑 결과가 상식적인 범위인지 검증하는 공용 로직. 두 회의
 * 모두 연 8회가 정상이라, 그 범위를 크게 벗어나면 사이트 개편으로 파싱이 깨진
 * 것으로 간주한다 — 이때 호출부(scripts/sync-rate-schedules.ts)는 기존 DB 값을
 * 그대로 두고 에러만 남겨야 한다. 아직 발표 전인 미래 연도는 0건도 정상이다
 * (BOK는 보통 그해 11~12월에, FOMC는 1~2년 앞서 다음 해 일정을 공개한다 —
 * 2026-08-30 진단에서 BOK 2027년은 0건, FOMC 2027년은 이미 8건 확인됨).
 */

export interface ScrapedMeeting {
  date: string; // YYYY-MM-DD
  year: number;
  sourceLabel: string;
}

export const MEETING_COUNT_MIN = 6;
export const MEETING_COUNT_MAX = 10;

export function validateYearlyMeetingCounts(
  meetings: ScrapedMeeting[],
  years: number[],
  currentYear: number
): string | null {
  for (const year of years) {
    const count = meetings.filter((m) => m.year === year).length;
    if (year > currentYear && count === 0) continue;
    if (count < MEETING_COUNT_MIN || count > MEETING_COUNT_MAX) {
      return `${year}년 회의 개수가 비정상입니다(${count}건, 정상 범위 ${MEETING_COUNT_MIN}~${MEETING_COUNT_MAX}건${
        year > currentYear ? " 또는 미발표 0건" : ""
      }) — 페이지 구조 변경 가능성`;
    }
  }
  return null;
}
