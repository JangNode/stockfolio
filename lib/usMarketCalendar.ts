/**
 * 미국 정규장(나스닥/뉴욕/아멕스, 09:30~16:00 ET) 관련 날짜 계산. 서머타임(DST) 전환은
 * 매년 손으로 크론을 바꾸는 대신, Node에 내장된 IANA 타임존 DB(America/New_York)를 통해
 * 자동으로 반영되게 한다 — DST 시작/종료 규칙이 바뀌어도 이 파일을 고칠 필요가 없다.
 *
 * 휴장일은 KIS API에서 미국 시장 휴장일 조회 엔드포인트를 찾지 못해(문서 접근 제한),
 * NYSE 공식 휴장일 규칙을 직접 계산한다 — 연도별로 날짜를 하드코딩하지 않고 매년 자동
 * 계산되므로 별도 갱신이 필요 없다. 다만 NYSE가 규칙 자체를 바꾸는 드문 경우(예: 2022년
 * 준틴스 신설)엔 이 파일도 같이 고쳐야 한다.
 */

function addUtcDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function toDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** 그레고리력 부활절(춘분 이후 첫 보름 다음 일요일) 계산 — Meeus/Jones/Butcher 알고리즘. */
function computeEasterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); // 3=3월, 4=4월
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

/** weekday: 0=일 ~ 6=토. n번째 해당 요일. */
function nthWeekdayOfMonth(year: number, monthIndex0: number, weekday: number, n: number): Date {
  const first = new Date(Date.UTC(year, monthIndex0, 1));
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  return new Date(Date.UTC(year, monthIndex0, 1 + offset + (n - 1) * 7));
}

function lastWeekdayOfMonth(year: number, monthIndex0: number, weekday: number): Date {
  const lastDay = new Date(Date.UTC(year, monthIndex0 + 1, 0)).getUTCDate();
  const last = new Date(Date.UTC(year, monthIndex0, lastDay));
  const diff = (last.getUTCDay() - weekday + 7) % 7;
  return new Date(Date.UTC(year, monthIndex0, lastDay - diff));
}

/** 토요일이면 전 금요일로, 일요일이면 다음 월요일로 당겨서 쉬는 고정일 휴장 규칙. */
function observedFixedDate(date: Date): Date {
  const weekday = date.getUTCDay();
  if (weekday === 6) return addUtcDays(date, -1);
  if (weekday === 0) return addUtcDays(date, 1);
  return date;
}

/** 해당 연도의 NYSE 휴장일 집합(YYYY-MM-DD)을 계산한다. */
function computeNyseHolidays(year: number): Set<string> {
  const easter = computeEasterSunday(year);
  const goodFriday = addUtcDays(easter, -2);

  const holidays = [
    observedFixedDate(new Date(Date.UTC(year, 0, 1))), // 신정
    nthWeekdayOfMonth(year, 0, 1, 3), // MLK Day: 1월 세 번째 월요일
    nthWeekdayOfMonth(year, 1, 1, 3), // Washington's Birthday: 2월 세 번째 월요일
    goodFriday, // 성금요일
    lastWeekdayOfMonth(year, 4, 1), // Memorial Day: 5월 마지막 월요일
    observedFixedDate(new Date(Date.UTC(year, 5, 19))), // Juneteenth (2022년부터)
    observedFixedDate(new Date(Date.UTC(year, 6, 4))), // 독립기념일
    nthWeekdayOfMonth(year, 8, 1, 1), // Labor Day: 9월 첫 번째 월요일
    nthWeekdayOfMonth(year, 10, 4, 4), // 추수감사절: 11월 네 번째 목요일
    observedFixedDate(new Date(Date.UTC(year, 11, 25))), // 크리스마스
  ];

  return new Set(holidays.map(toDateKey));
}

const holidayCache = new Map<number, Set<string>>();

function getNyseHolidays(year: number): Set<string> {
  let cached = holidayCache.get(year);
  if (!cached) {
    cached = computeNyseHolidays(year);
    holidayCache.set(year, cached);
  }
  return cached;
}

/** dateKey(YYYY-MM-DD, 뉴욕 달력 기준)가 NYSE 정규 거래일(평일이고 휴장일이 아님)인지. */
export function isNyseTradingDay(dateKey: string): boolean {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = date.getUTCDay();
  if (weekday === 0 || weekday === 6) return false;

  return !getNyseHolidays(year).has(dateKey);
}

/** 지금 이 순간의 뉴욕 달력 날짜(YYYY-MM-DD)를 반환한다. DST는 Intl이 자동 반영한다. */
export function getCurrentNyDateKey(): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).formatToParts(
    new Date()
  );
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * 배치가 참조해야 할 미국 거래일과 그 날이 실제 거래일이었는지를 함께 반환한다. 이 배치는
 * 정규장이 EDT/EST 어느 쪽이든 이미 마감된 이후(KST 06:30 고정)에만 돌게 스케줄되므로,
 * "지금 뉴욕 날짜"가 곧 확정된 종가를 가진 거래일이다 — 날짜를 하루 밀 필요가 없다.
 */
export function getUsBatchTradingDate(): { dateKey: string; isTradingDay: boolean } {
  const dateKey = getCurrentNyDateKey();
  return { dateKey, isTradingDay: isNyseTradingDay(dateKey) };
}
