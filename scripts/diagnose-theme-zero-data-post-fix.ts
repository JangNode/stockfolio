/**
 * (임시) 사용자가 "9월 1일 이후 테마 등락률이 한 번도 생성되지 않았다"(9/2, 9/3
 * 전부 12개 테마 데이터 없음, 구성종목 수 0개)고 보고한 문제를 실데이터로 조사한다.
 * DB에는 아무것도 쓰지 않는 읽기 전용 진단 — 확인 끝나면 정리 PR에서
 * 스크립트/워크플로와 함께 삭제한다.
 *
 * 가설: 이 문제 직전에 병합한 수정(PR #193, "테마 등락률 일별 조회 시 우연히 0%가
 * 되는 버그 수정")이 daily 기간 조회에서 종료가를 정확한 날짜로만(폴백 없이) 찾도록
 * 바꿨다. stock_daily_prices_recent는 KRX 정산 데이터를 "그 다음날" 배치가 채우므로,
 * 예를 들어 9/2의 종가는 9/3 14:30 KST 정규 배치(update-stock-daily-prices-recent
 * 스텝)가 돌아야 채워진다. 그 전(9/3 새벽~14:30 KST 사이)에 "9/2 daily"를 조회하면
 * 정확한 날짜 매칭이 실패해 "데이터 없음"으로 보인다 — 이건 신규 버그가 아니라
 * PR #193이 의도한 정확한 동작(예전엔 폴백으로 우연히 0%를 잘못 보여줬던 것)일
 * 가능성이 있다. GitHub Actions 실행 이력으로 이미 확인한 사실: 가장 최근 성공한
 * screening.yml 실행이 2026-09-02 14:30 KST(run 33594905414)이고, 그 이후(9/3)
 * 실행 기록이 아직 없다.
 *
 * 확인 순서:
 * 1) theme_daily_returns: 8/31~9/3 각 날짜별 행 개수(재확인 — 삭제/변경 여부 포함)
 * 2) stock_daily_prices_recent: 8/31~9/3 각 날짜에 실제 행이 있는지(샘플 종목
 *    몇 개로 직접 확인) — "그 날짜의 종가가 언제부터 조회 가능한지"를 직접 증명
 * 3) screening_runs: 9/3자 실행 기록이 실제로 있는지 없는지
 * 4) app/api/themes/route.ts 로직을 그대로 재현해 "지금 이 순간" date=9/1,
 *    date=9/2, 파라미터 없음(오늘=9/3) 각각 실제로 무엇을 반환하는지 직접 재현
 *
 * 필요 환경변수: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   tsx --conditions=react-server scripts/diagnose-theme-zero-data-post-fix.ts
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getStockCodesByTheme } from "@/lib/stockMaster";
import {
  averageReturnPct,
  computeStockReturnsForPeriod,
  resolveThemePeriodRange,
} from "@/lib/themeReturns";

const CHECK_DATES = ["2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03"];
const SAMPLE_STOCK_CODES = ["005930", "000660", "004450"]; // 삼성전자, SK하이닉스, 삼화왕관

function todayKstDate(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined) return "null";
  return n.toLocaleString("ko-KR", { maximumFractionDigits: 4 });
}

async function main(): Promise<void> {
  const today = todayKstDate();
  console.log(`=== 테마 등락률 9/1 이후 미생성 조사 (지금 서버 기준 오늘 KST: ${today}) ===\n`);

  console.log("--- 1) theme_daily_returns: 날짜별 행 개수 재확인 ---");
  const { data: rows, error } = await supabaseAdmin
    .from("theme_daily_returns")
    .select("trade_date, theme_code, change_rate_pct, constituent_count, created_at")
    .in("trade_date", CHECK_DATES);
  if (error) throw new Error(`theme_daily_returns 조회 실패: ${error.message}`);
  const byDate = new Map<string, number>();
  for (const r of rows ?? []) {
    byDate.set(r.trade_date, (byDate.get(r.trade_date) ?? 0) + 1);
  }
  for (const d of CHECK_DATES) {
    console.log(`  ${d}: ${byDate.get(d) ?? 0}개 행`);
  }
  const sep02Row = (rows ?? []).find((r) => r.trade_date === "2026-09-02");
  if (sep02Row) {
    console.log(`  → 9/2 샘플 행: theme_code=${sep02Row.theme_code} change_rate_pct=${fmt(sep02Row.change_rate_pct)} constituent_count=${sep02Row.constituent_count} created_at=${sep02Row.created_at}`);
  }

  console.log("\n--- 2) stock_daily_prices_recent: 날짜별 실제 시세 존재 여부(샘플 종목) ---");
  for (const code of SAMPLE_STOCK_CODES) {
    const { data: priceRows, error: priceError } = await supabaseAdmin
      .from("stock_daily_prices_recent")
      .select("trade_date, close_price")
      .eq("stock_code", code)
      .in("trade_date", CHECK_DATES)
      .order("trade_date", { ascending: true });
    if (priceError) throw new Error(`stock_daily_prices_recent 조회 실패: ${priceError.message}`);
    const existingDates = new Set((priceRows ?? []).map((r) => r.trade_date as string));
    console.log(`  ${code}: ${CHECK_DATES.map((d) => `${d}=${existingDates.has(d) ? "있음" : "없음"}`).join(", ")}`);
  }
  const { data: maxRow } = await supabaseAdmin
    .from("stock_daily_prices_recent")
    .select("trade_date")
    .order("trade_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  console.log(`  → stock_daily_prices_recent 전체 최신 trade_date: ${maxRow?.trade_date ?? "없음"}`);

  console.log("\n--- 3) screening_runs: 9/3자 실행 기록 존재 여부 ---");
  const { data: runs, error: runsError } = await supabaseAdmin
    .from("screening_runs")
    .select("started_at, finished_at, scanned_count, matched_count, error_count")
    .gte("started_at", "2026-09-02T20:00:00Z")
    .order("started_at", { ascending: true });
  if (runsError) throw new Error(`screening_runs 조회 실패: ${runsError.message}`);
  if (!runs || runs.length === 0) {
    console.log("  2026-09-02T20:00 UTC(9/3 05:00 KST) 이후 실행 기록 없음 — 9/3 정규 배치가 아직 안 돎.");
  } else {
    for (const r of runs) {
      console.log(`  started_at=${r.started_at} finished_at=${r.finished_at} scanned=${r.scanned_count} matched=${r.matched_count} errors=${r.error_count}`);
    }
  }

  console.log("\n--- 4) app/api/themes/route.ts 로직 재현: 지금 이 순간 실제 반환값 ---");
  for (const dateParam of ["2026-09-01", "2026-09-02", null]) {
    const range = resolveThemePeriodRange("daily", { date: dateParam }, today);
    console.log(
      `\n  [date=${dateParam ?? "(파라미터 없음, 기본값=오늘)"}] periodStartDate=${range.periodStartDate} ` +
        `referenceEndDate=${range.referenceEndDate} isToday=${range.isToday}`
    );
    if (range.isToday) {
      const { data: todayRows } = await supabaseAdmin
        .from("theme_daily_returns")
        .select("theme_code")
        .eq("trade_date", range.referenceEndDate);
      console.log(`    isToday=true → theme_daily_returns(trade_date=${range.referenceEndDate}) ${todayRows?.length ?? 0}개 행`);
    } else {
      const codesByTheme = await getStockCodesByTheme();
      const semiCodes = codesByTheme.krx_semiconductor;
      const returns = await computeStockReturnsForPeriod(semiCodes, range);
      const avg = averageReturnPct(returns);
      console.log(
        `    isToday=false → 재계산 경로(computeStockReturnsForPeriod), 반도체 기준: ` +
          `${returns.size}/${semiCodes.length}종목 계산됨, 평균=${fmt(avg)}%`
      );
    }
  }

  console.log("\n=== 조사 종료 ===");
}

main().catch((error) => {
  console.error("진단 스크립트 실행 중 오류:", error);
  process.exit(1);
});
