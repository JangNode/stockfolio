import "server-only";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getDomesticHolidayCheck, type KrxHolidayCheckDay } from "@/lib/kis";

/**
 * 한국거래소(KRX) 거래일 캘린더. KIS 국내휴장일조회(chk-holiday)가 한 번 호출에
 * baseDate부터 정확히 24일치만 주기 때문에(2026-09-25 실측 확인), 필요한 개월 수를
 * 채울 때까지 이어서 호출해 모은다.
 * scripts/sync-krx-trading-calendar.ts가 연 1회 이 모듈로 전체 재수집 →
 * 검증 → 교체를 수행한다(FOMC/금통위 일정 동기화와 동일 패턴, lib/scheduleStorage.ts
 * 참고).
 */

function todayKstYyyymmdd(): string {
  return new Date()
    .toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" })
    .replace(/-/g, "");
}

// lib/kis.ts의 동명 함수와 동일한 구현(달력 계산은 UTC 기준으로 통일해 시스템
// 타임존과 무관하게 항상 같은 결과가 나오게 한다).
function addDaysToYyyymmdd(yyyymmdd: string, days: number): string {
  const d = new Date(
    Date.UTC(
      Number(yyyymmdd.slice(0, 4)),
      Number(yyyymmdd.slice(4, 6)) - 1,
      Number(yyyymmdd.slice(6, 8))
    )
  );
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

export interface KrxTradingDay {
  date: string; // YYYY-MM-DD
  isOpen: boolean;
}

/**
 * 오늘부터 monthsAhead개월치 개장일 여부를 모아 반환한다. KIS API가 호출 한 번에
 * 24일치만 주므로, 다음 호출의 BASS_DT를 "이전 호출 마지막 날짜의 다음날"로 이어
 * 붙여 필요한 기간을 다 채울 때까지 반복 호출한다.
 */
export async function fetchKrxTradingCalendar(monthsAhead: number): Promise<KrxTradingDay[]> {
  const targetDays = monthsAhead * 31; // 월별 실제 일수 차이를 여유로 흡수(넉넉히 더 모으는 쪽이 안전)
  const collected: KrxHolidayCheckDay[] = [];
  let baseDate = todayKstYyyymmdd();

  while (collected.length < targetDays) {
    const batch = await getDomesticHolidayCheck(baseDate);
    if (batch.length === 0) break; // 방어적 종료 — 정상 응답이면 항상 24일치가 온다
    collected.push(...batch);

    const lastDate = batch[batch.length - 1].date.replace(/-/g, "");
    baseDate = addDaysToYyyymmdd(lastDate, 1);
  }

  return collected.map((day) => ({ date: day.date, isOpen: day.isOpen }));
}

// 한국 증시 정상 개장일수는 연간 245일 전후다(365일 - 주말 약 104일 - 공휴일
// 15일 전후, 최근 수년간 실제 개장일수 기준). 이 범위를 크게 벗어나면 KIS 응답
// 구조가 바뀌었거나(필드명 변경 등) 파싱이 깨진 것으로 간주해 저장하지 않는다.
export const KRX_OPEN_DAYS_PER_YEAR_MIN = 240;
export const KRX_OPEN_DAYS_PER_YEAR_MAX = 260;

/**
 * 수집된 거래일 캘린더가 상식적인 범위인지 검증한다. days에 걸쳐 있는 연도별로
 * "그 연도에 속한 날짜 수가 365일에 가까운(즉 연간 전체가 커버된) 연도"만 개장일수
 * 범위를 확인한다 — 수집 기간의 시작/끝에 걸쳐 일부만 포함된 연도는 표본이 적어
 * 정상적으로도 범위를 벗어나므로 검증 대상에서 뺀다.
 */
export function validateKrxTradingCalendarCoverage(days: KrxTradingDay[]): string | null {
  const byYear = new Map<string, KrxTradingDay[]>();
  for (const day of days) {
    const year = day.date.slice(0, 4);
    const list = byYear.get(year) ?? [];
    list.push(day);
    byYear.set(year, list);
  }

  // 그 연도 전체(365/366일)의 90% 이상이 수집 범위에 포함된 연도만 검증한다.
  const FULL_YEAR_COVERAGE_THRESHOLD = 0.9;

  for (const [year, yearDays] of byYear) {
    const isLeap = new Date(Number(year), 1, 29).getMonth() === 1;
    const daysInYear = isLeap ? 366 : 365;
    if (yearDays.length < daysInYear * FULL_YEAR_COVERAGE_THRESHOLD) continue;

    const openCount = yearDays.filter((d) => d.isOpen).length;
    if (openCount < KRX_OPEN_DAYS_PER_YEAR_MIN || openCount > KRX_OPEN_DAYS_PER_YEAR_MAX) {
      return (
        `${year}년 개장일수가 비정상입니다(${openCount}일, 정상 범위 ` +
        `${KRX_OPEN_DAYS_PER_YEAR_MIN}~${KRX_OPEN_DAYS_PER_YEAR_MAX}일) — KIS 응답 구조 변경 가능성`
      );
    }
  }

  return null;
}

/** 검증까지 통과했을 때만 호출된다 — 캘린더 전체를 새 결과로 교체한다(FOMC/금통위
 * replaceFomcSchedule과 동일 패턴, delete-all-then-insert). */
export async function replaceKrxTradingCalendar(days: KrxTradingDay[]): Promise<void> {
  const { error: deleteError } = await supabaseAdmin
    .from("krx_trading_calendar")
    .delete()
    .gte("trade_date", "1900-01-01");
  if (deleteError) throw new Error(`KRX 거래일 캘린더 삭제 실패: ${deleteError.message}`);
  if (days.length === 0) return;

  const { error } = await supabaseAdmin.from("krx_trading_calendar").insert(
    days.map((d) => ({
      trade_date: d.date,
      is_open: d.isOpen,
      source_label: "KIS chk-holiday",
    }))
  );
  if (error) throw new Error(`KRX 거래일 캘린더 저장 실패: ${error.message}`);
}

/** 수집 시도마다 성공/실패를 남긴다(schedule_scrape_status의 'KRX_CALENDAR' 행,
 * FOMC/MPC와 같은 테이블 재사용) — 실패해도 last_error만 갱신할 뿐 캘린더 테이블은
 * 건드리지 않는다(기존 값 유지). */
export async function recordKrxCalendarSyncAttempt(
  errorMessage: string | null,
  dayCount: number | null
): Promise<void> {
  const now = new Date().toISOString();
  const update: Record<string, unknown> = { source: "KRX_CALENDAR", last_attempt_at: now };
  if (errorMessage) {
    update.last_error = errorMessage;
  } else {
    update.last_error = null;
    update.last_success_at = now;
    update.last_meeting_count = dayCount;
  }
  const { error } = await supabaseAdmin.from("schedule_scrape_status").upsert(update);
  if (error) throw new Error(`KRX 거래일 캘린더 수집 상태 기록 실패: ${error.message}`);
}

/**
 * dateIso(YYYY-MM-DD)가 KRX 거래일(개장일)인지 조회한다. 캘린더에 그 날짜 데이터가
 * 없으면(동기화가 오래 안 됐거나 수집 커버리지 밖) true(거래일로 간주)를 반환하고
 * 경고를 남긴다 — 의도적인 fail-open 설계다. 데이터가 없다고 무조건 거래일이
 * 아니라고 막아버리면, 캘린더 동기화가 한 번이라도 실패했을 때 정상 거래일까지
 * 영원히 스킵하게 되는 쪽이 지금 이 배치를 도입하는 원인이 된 버그(휴장일에도
 * 그냥 도는 것)보다 더 나쁜 실패 모드이기 때문이다.
 */
export async function isKrxTradingDay(dateIso: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("krx_trading_calendar")
    .select("is_open")
    .eq("trade_date", dateIso)
    .maybeSingle();
  if (error) throw new Error(`KRX 거래일 캘린더 조회 실패: ${error.message}`);

  if (!data) {
    console.warn(
      `[krxTradingCalendar] ${dateIso}의 캘린더 데이터가 없어 거래일로 간주하고 진행합니다 ` +
        `(fail-open) — KRX 캘린더 동기화 상태를 확인하세요.`
    );
    return true;
  }

  return data.is_open;
}
