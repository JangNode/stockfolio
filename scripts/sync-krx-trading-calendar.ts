/**
 * 한국거래소(KRX) 거래일 캘린더를 연 1회 KIS 국내휴장일조회(chk-holiday)에서 자동
 * 수집해 DB에 반영하는 배치. 파싱/검증 실패 시 기존 저장된 캘린더는 그대로 두고
 * 에러만 명확히 남긴다(절대 덮어쓰지 않음) — 워크플로 자체가 실패로 끝나 눈에
 * 띄게 한다. 성공하면 캘린더 전체를 최신 결과로 교체한다.
 * scripts/sync-rate-schedules.ts와 동일한 형태다.
 *
 * 필요 환경변수: KIS_APP_KEY, KIS_APP_SECRET, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   tsx --conditions=react-server scripts/sync-krx-trading-calendar.ts
 */
import {
  fetchKrxTradingCalendar,
  recordKrxCalendarSyncAttempt,
  replaceKrxTradingCalendar,
  validateKrxTradingCalendarCoverage,
} from "@/lib/krxTradingCalendar";

// 연 1회 갱신이라 다음 갱신 전까지(내년 1월 2일) 여유 있게 15개월치를 모아둔다.
const MONTHS_AHEAD = 15;

async function main(): Promise<void> {
  let days;
  try {
    days = await fetchKrxTradingCalendar(MONTHS_AHEAD);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[KRX_CALENDAR] 수집 실패: ${message}`);
    await recordKrxCalendarSyncAttempt(message, null);
    process.exit(1);
  }

  const validationError = validateKrxTradingCalendarCoverage(days);
  if (validationError) {
    console.error(`[KRX_CALENDAR] 검증 실패: ${validationError} — 기존 캘린더를 그대로 유지합니다.`);
    await recordKrxCalendarSyncAttempt(validationError, null);
    process.exit(1);
  }

  await replaceKrxTradingCalendar(days);
  await recordKrxCalendarSyncAttempt(null, days.length);
  console.log(`[KRX_CALENDAR] 수집 성공: 총 ${days.length}일치(그중 개장일 ${days.filter((d) => d.isOpen).length}일)`);
}

main().catch((error) => {
  console.error("KRX 거래일 캘린더 동기화 배치 중 예상치 못한 오류가 발생했습니다:", error);
  process.exit(1);
});
