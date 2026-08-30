import "server-only";
import type { ScrapedMeeting } from "@/lib/scheduleValidation";

const FOMC_CALENDAR_URL = "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm";

const MONTHS: Record<string, number> = {
  January: 1,
  February: 2,
  March: 3,
  April: 4,
  May: 5,
  June: 6,
  July: 7,
  August: 8,
  September: 9,
  October: 10,
  November: 11,
  December: 12,
};

/**
 * federalreserve.gov 공식 캘린더 페이지에서 FOMC 회의 일정을 파싱한다. 페이지는
 * 연도별 패널(`<a id="…">YYYY FOMC Meetings</a>`)로 구성되고, 각 회의는
 * "fomc-meeting__month"(월)/"fomc-meeting__date"(일, "27-28"처럼 시작-종료일
 * 표기이며 성명서 발표는 종료일에 나옴)로 표시된다 — 2026-08-30 GitHub Actions
 * 진단으로 실제 구조를 확인했다. 다음 해 일정도 같은 페이지에 미리 올라와 있다
 * (2026-08 기준 2027년 8회 모두 확인됨).
 */
export async function scrapeFomcSchedule(): Promise<ScrapedMeeting[]> {
  const res = await fetch(FOMC_CALENDAR_URL, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; stockfolio-schedule-sync/1.0)" },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`FOMC 캘린더 페이지 요청 실패 (${res.status})`);
  }
  const text = (await res.text()).replace(/\s+/g, " ");

  const yearHeaderPattern = /<a id="\d+">(\d{4}) FOMC Meetings<\/a>/g;
  const headers: { year: number; start: number }[] = [];
  for (const m of text.matchAll(yearHeaderPattern)) {
    headers.push({ year: Number(m[1]), start: (m.index ?? 0) + m[0].length });
  }
  if (headers.length === 0) {
    throw new Error("FOMC 캘린더 페이지에서 연도 섹션을 찾지 못했습니다 (페이지 구조 변경 가능성)");
  }

  const meetingPattern =
    /fomc-meeting__month[^"]*"><strong>([A-Za-z]+)<\/strong><\/div>\s*<div class="fomc-meeting__date[^"]*">\s*(\d{1,2})(?:-(\d{1,2}))?\*?\s*<\/div>/g;

  const meetings: ScrapedMeeting[] = [];
  for (let i = 0; i < headers.length; i++) {
    const { year, start } = headers[i];
    const end = i + 1 < headers.length ? headers[i + 1].start : Math.min(text.length, start + 8000);
    const block = text.slice(start, end);
    for (const m of block.matchAll(meetingPattern)) {
      const month = MONTHS[m[1]];
      if (!month) continue;
      const day = Number(m[3] ?? m[2]);
      meetings.push({
        date: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
        year,
        sourceLabel: `${m[1]} ${m[2]}${m[3] ? "-" + m[3] : ""}`,
      });
    }
  }
  return meetings;
}
