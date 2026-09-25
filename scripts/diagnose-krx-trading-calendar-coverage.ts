/**
 * [디스포저블 진단 스크립트] 방금 처음 실행된 KRX 거래일 캘린더 동기화
 * (scripts/sync-krx-trading-calendar.ts) 결과를 실제 DB에서 확인한다. 24일
 * 단위 체이닝 수집 로직에 날짜 공백(gap)이 없는지, 연도별 개장일수가 상식
 * 범위(240~260일)인지 재확인한다. DB 쓰기 없음(순수 조회).
 *
 * 필요 환경변수: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   tsx --conditions=react-server scripts/diagnose-krx-trading-calendar-coverage.ts
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";

async function main(): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from("krx_trading_calendar")
    .select("trade_date, is_open")
    .order("trade_date", { ascending: true });
  if (error) throw new Error(`조회 실패: ${error.message}`);
  if (!data || data.length === 0) {
    console.log("krx_trading_calendar에 데이터가 없습니다.");
    return;
  }

  console.log(`총 ${data.length}행, 범위: ${data[0].trade_date} ~ ${data[data.length - 1].trade_date}`);

  const gaps: string[] = [];
  for (let i = 1; i < data.length; i++) {
    const prev = new Date(`${data[i - 1].trade_date}T00:00:00Z`);
    const cur = new Date(`${data[i].trade_date}T00:00:00Z`);
    const diffDays = (cur.getTime() - prev.getTime()) / (1000 * 60 * 60 * 24);
    if (diffDays !== 1) {
      gaps.push(`${data[i - 1].trade_date} -> ${data[i].trade_date} (${diffDays}일 차이)`);
    }
  }
  console.log(gaps.length === 0 ? "날짜 공백 없음(연속 확인됨)." : `날짜 공백 발견:\n  ${gaps.join("\n  ")}`);

  const byYear = new Map<string, { total: number; open: number }>();
  for (const row of data) {
    const year = row.trade_date.slice(0, 4);
    const entry = byYear.get(year) ?? { total: 0, open: 0 };
    entry.total += 1;
    if (row.is_open) entry.open += 1;
    byYear.set(year, entry);
  }
  for (const [year, { total, open }] of [...byYear.entries()].sort()) {
    console.log(`${year}년: 수집 ${total}일 중 개장일 ${open}일`);
  }

  const { data: statusRow, error: statusError } = await supabaseAdmin
    .from("schedule_scrape_status")
    .select("*")
    .eq("source", "KRX_CALENDAR")
    .maybeSingle();
  if (statusError) throw new Error(`schedule_scrape_status 조회 실패: ${statusError.message}`);
  console.log("schedule_scrape_status(KRX_CALENDAR):", JSON.stringify(statusRow));
}

main().catch((error) => {
  console.error("진단 중 오류:", error);
  process.exit(1);
});
