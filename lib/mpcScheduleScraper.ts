import "server-only";
import type { ScrapedMeeting } from "@/lib/scheduleValidation";

function listUrl(year: number): string {
  return `https://www.bok.or.kr/portal/singl/crncyPolicyDrcMtg/listYear.do?mtgSe=A&menuNo=200755&pYear=${year}`;
}

/**
 * 한국은행 "통화정책방향 결정회의 일정 및 자료" 목록 페이지에서 연도별 회의
 * 일정을 파싱한다. 이 목록 페이지 자체가 통화정책방향 결정회의 전용이라(같은
 * 사이트의 금융안정회의 등 다른 회의 유형은 별도 메뉴·URL로 분리돼 있음)
 * caption이 "통화정책방향 회의"인 테이블 하나만 있고, 그 안의 각 행
 * (`<th scope="row">MM월 DD일(요일)</th>`)이 바로 연 8회 결정회의 날짜다 —
 * 2026-08-30 GitHub Actions 진단으로 2025/2026년 모두 정확히 8행임을 확인했다.
 * 아직 발표되지 않은 미래 연도를 요청하면 같은 구조의 빈 테이블(행 0개)이
 * 온다 — 에러가 아니라 "미발표"로 처리해야 한다(호출부 lib/scheduleValidation.ts).
 */
export async function scrapeMpcScheduleForYear(year: number): Promise<ScrapedMeeting[]> {
  const res = await fetch(listUrl(year), {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; stockfolio-schedule-sync/1.0)" },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`금통위 일정 페이지 요청 실패 (${year}년, ${res.status})`);
  }
  const text = (await res.text()).replace(/\s+/g, " ");

  const captionIdx = text.indexOf("통화정책방향 회의</caption>");
  if (captionIdx < 0) {
    throw new Error(`금통위 일정 테이블을 찾지 못했습니다 (${year}년, 페이지 구조 변경 가능성)`);
  }
  const tbodyMatch = text.slice(captionIdx).match(/<tbody>([\s\S]*?)<\/tbody>/);
  if (!tbodyMatch) {
    throw new Error(`금통위 일정 테이블의 tbody를 찾지 못했습니다 (${year}년, 페이지 구조 변경 가능성)`);
  }

  const rowPattern = /<th scope="row">\s*(\d{1,2})월\s*(\d{1,2})일/g;
  const meetings: ScrapedMeeting[] = [];
  for (const m of tbodyMatch[1].matchAll(rowPattern)) {
    const month = Number(m[1]);
    const day = Number(m[2]);
    meetings.push({
      date: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
      year,
      sourceLabel: `${m[1]}월 ${m[2]}일`,
    });
  }
  return meetings;
}

export async function scrapeMpcSchedule(years: number[]): Promise<ScrapedMeeting[]> {
  const all: ScrapedMeeting[] = [];
  for (const year of years) {
    all.push(...(await scrapeMpcScheduleForYear(year)));
  }
  return all;
}
