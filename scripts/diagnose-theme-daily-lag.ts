/**
 * (임시) 테마 등락률이 하루 밀리는 문제(9/2에 조회해도 9/1이 최신, 9/3 지금 조회해도
 * 여전히 9/1이 최신이고 9/2 데이터가 없음)를 실데이터로 조사한다. DB에는 아무것도
 * 쓰지 않는 읽기 전용 진단 — 확인 끝나면 정리 PR에서 스크립트/워크플로와 함께
 * 삭제한다.
 *
 * 이미 GitHub Actions 로그로 확인한 사실: 2026-09-02 14:30 KST 배치(run 33594905414)의
 * "Run screening batch" 스텝이 "테마 등락률 집계 완료: 반도체 0.05%(27종목), ..." 로그를
 * 남기며 정상 종료했다 — 이 로그는 lib/themeReturns.ts가 아니라
 * scripts/screen-all-stocks.ts의 computeAndStoreThemeReturns()가 upsert 에러 없이
 * 성공했을 때만 찍힌다(에러면 그 앞에서 return하고 이 로그를 안 찍음). 즉 쓰기 자체는
 * 성공한 것으로 보이는데, 사용자는 그 다음날(9/3)에도 여전히 9/1이 최신이라고 보고했다
 * — 이 스크립트로 실제 DB의 theme_daily_returns 최근 행을 직접 확인해 (a) 9/2 행이
 * 실제로 있는지 (b) 있다면 화면/조회 쪽 문제인지, 없다면 쓰기 자체가 실제로는 실패했는지
 * 가른다.
 *
 * 확인 순서:
 * 1) theme_daily_returns에서 최근 5거래일치 모든 행(날짜별로 몇 개 테마가 있는지)
 * 2) 2026-09-02 행이 정확히 있는지/몇 개 테마인지
 * 3) screening_runs(오늘 배치 실행 기록)의 8/29~9/3 이력 — 매일 실행됐는지
 * 4) app/api/themes/route.ts가 실제로 반환할 값을 그대로 재현
 *    (resolveThemePeriodRange + 관련 조회 로직을 그대로 흉내)
 *
 * 필요 환경변수: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   tsx --conditions=react-server scripts/diagnose-theme-daily-lag.ts
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { THEME_LABELS, type ThemeCode } from "@/lib/themeConfig";
import { resolveThemePeriodRange } from "@/lib/themeReturns";

function todayKstDate(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined) return "null";
  return n.toLocaleString("ko-KR", { maximumFractionDigits: 4 });
}

interface ThemeDailyReturnRow {
  trade_date: string;
  theme_code: string;
  change_rate_pct: number;
  constituent_count: number;
  created_at: string;
}

async function main(): Promise<void> {
  const today = todayKstDate();
  console.log(`=== 테마 등락률 하루 밀림 조사 (오늘 KST: ${today}) ===\n`);

  console.log("--- 1) theme_daily_returns 최근 행 전체(2026-08-28 이후) ---");
  const { data: rows, error } = await supabaseAdmin
    .from("theme_daily_returns")
    .select("trade_date, theme_code, change_rate_pct, constituent_count, created_at")
    .gte("trade_date", "2026-08-28")
    .order("trade_date", { ascending: true })
    .order("theme_code", { ascending: true });
  if (error) throw new Error(`theme_daily_returns 조회 실패: ${error.message}`);
  const typedRows = (rows ?? []) as ThemeDailyReturnRow[];

  const byDate = new Map<string, ThemeDailyReturnRow[]>();
  for (const r of typedRows) {
    const list = byDate.get(r.trade_date) ?? [];
    list.push(r);
    byDate.set(r.trade_date, list);
  }
  for (const [date, list] of Array.from(byDate.entries()).sort()) {
    console.log(`  ${date}: ${list.length}개 테마, 최초 저장 시각(created_at)=${list[0]?.created_at}`);
  }
  const distinctDates = Array.from(byDate.keys()).sort();
  console.log(`  → 존재하는 날짜 목록: ${distinctDates.join(", ") || "(없음)"}`);
  console.log(`  → 가장 최신 날짜: ${distinctDates[distinctDates.length - 1] ?? "없음"}`);

  console.log("\n--- 2) 2026-09-02 행 상세 확인 ---");
  const sep02 = byDate.get("2026-09-02");
  if (!sep02) {
    console.log("  2026-09-02 행이 DB에 전혀 없습니다.");
  } else {
    console.log(`  2026-09-02 행 ${sep02.length}개:`);
    for (const r of sep02) {
      console.log(
        `    ${THEME_LABELS[r.theme_code as ThemeCode] ?? r.theme_code}: change_rate_pct=${fmt(r.change_rate_pct)} ` +
          `constituent_count=${r.constituent_count} created_at=${r.created_at}`
      );
    }
  }

  console.log("\n--- 3) screening_runs 최근 실행 이력(2026-08-28 이후) ---");
  const { data: runs, error: runsError } = await supabaseAdmin
    .from("screening_runs")
    .select("started_at, finished_at, scanned_count, matched_count, error_count")
    .gte("started_at", "2026-08-28T00:00:00Z")
    .order("started_at", { ascending: true });
  if (runsError) throw new Error(`screening_runs 조회 실패: ${runsError.message}`);
  for (const r of runs ?? []) {
    console.log(
      `  started_at=${r.started_at} finished_at=${r.finished_at} scanned=${r.scanned_count} ` +
        `matched=${r.matched_count} errors=${r.error_count}`
    );
  }

  console.log("\n--- 4) app/api/themes/route.ts 로직 재현: 지금 이 순간 daily(파라미터 없음, 기본값=오늘) 조회 시 ---");
  const range = resolveThemePeriodRange("daily", {}, today);
  console.log(`  resolveThemePeriodRange 결과: periodStartDate=${range.periodStartDate} referenceEndDate=${range.referenceEndDate} isToday=${range.isToday}`);
  if (range.isToday) {
    console.log(`  isToday=true → fetchTodayThemeRankings(${today}) 경로 — theme_daily_returns에서 trade_date=${today} 조회`);
    const { data: todayRows } = await supabaseAdmin
      .from("theme_daily_returns")
      .select("theme_code, change_rate_pct, constituent_count")
      .eq("trade_date", today);
    console.log(`  → ${today} 행 ${todayRows?.length ?? 0}개 (없으면 전부 "데이터 없음"으로 표시됨)`);
  }

  console.log("\n--- 5) 참고: '어제(9/1)를 명시적으로 daily로 조회'했을 때 ---");
  const rangeYesterday = resolveThemePeriodRange("daily", { date: "2026-09-01" }, today);
  console.log(
    `  periodStartDate=${rangeYesterday.periodStartDate} referenceEndDate=${rangeYesterday.referenceEndDate} isToday=${rangeYesterday.isToday}`
  );

  console.log("\n=== 조사 종료 ===");
}

main().catch((error) => {
  console.error("진단 스크립트 실행 중 오류:", error);
  process.exit(1);
});
