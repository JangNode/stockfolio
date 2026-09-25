/**
 * [디스포저블 진단 스크립트] KIS 국내휴장일조회(chk-holiday, tr_id CTCA0903R) 실제
 * 응답 구조 확인 — 한국거래소(KRX) 거래일 캘린더 도입(휴장일 배치 가드) 전, 필드명과
 * 한 번 호출에 몇 일치가 오는지 실측한다. DB 쓰기 없음(순수 조회).
 *
 * 확인 대상 날짜: 오늘(2026-09-25, 추석 연휴로 추정), 어제(2026-09-24, 추석 연휴로
 * 추정 — KRX 정산 데이터 0건으로 이미 확인됨), 그 전날(2026-09-23, 평일 거래일로
 * 추정), 그리고 참고용으로 한 달 전 날짜.
 *
 * 필요 환경변수: KIS_APP_KEY, KIS_APP_SECRET, NEXT_PUBLIC_SUPABASE_URL,
 *   SUPABASE_SERVICE_ROLE_KEY
 *   tsx --conditions=react-server scripts/diagnose-kis-holiday-check.ts
 */

import { getDomesticHolidayCheckRaw } from "@/lib/kis";

const PROBE_DATES = ["20260925", "20260924", "20260923", "20260825"];

async function main(): Promise<void> {
  for (const baseDate of PROBE_DATES) {
    console.log(`\n=== BASS_DT=${baseDate} ===`);
    try {
      const output = await getDomesticHolidayCheckRaw(baseDate);
      console.log(JSON.stringify(output, null, 2));
    } catch (error) {
      console.error(`  조회 실패: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

main().catch((error) => {
  console.error("진단 중 오류:", error);
  process.exit(1);
});
