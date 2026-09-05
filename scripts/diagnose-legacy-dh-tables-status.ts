/**
 * 사용자 요청: DH전략 백테스트용으로 설계했던 15년치 point-in-time 원자료
 * (dh_daily_market_data, dh_annual_fundamentals, dh_dividend_history,
 * dh_backfill_runs)가 실제로 존재하고 채워져 있는지 확인. 코드/스키마 변경 없음 —
 * 읽기 전용 1회성 확인 스크립트이며, 결과 확인 후 정리 PR로 즉시 제거한다.
 *
 * 사전 확인(마이그레이션 파일로 이미 파악됨, 이 스크립트에서는 실측만 함):
 * - dh_daily_market_data: 20260827050000에서 생성됐다가 같은 날
 *   20260827060000에서 DROP됨(무료 DB 500MB 초과, 639만 행에서 중단). 후속
 *   아키텍처는 Storage Parquet(stock-daily-prices 버킷) + hot 테이블
 *   (stock_daily_prices_recent, 최근 2년)로 완전히 대체됨 — 이 이름의 테이블은
 *   존재하지 않는다.
 * - dh_annual_fundamentals → stock_annual_fundamentals로 rename(20260828010000).
 * - dh_dividend_history → stock_dividend_history로 rename.
 * - dh_backfill_runs → stock_data_backfill_runs로 rename.
 *
 * 필요 환경변수: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   tsx --conditions=react-server scripts/diagnose-legacy-dh-tables-status.ts
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";

async function checkTableExists(table: string): Promise<boolean> {
  const { error } = await supabaseAdmin.from(table).select("*", { count: "exact", head: true });
  // 테이블이 없으면 PostgREST가 42P01(undefined_table)류 오류를 준다.
  if (error) {
    console.log(`  [${table}] 존재하지 않음(오류: ${error.message})`);
    return false;
  }
  return true;
}

async function countExact(table: string): Promise<number> {
  const { count, error } = await supabaseAdmin.from(table).select("*", { count: "exact", head: true });
  if (error) throw new Error(`${table} count 실패: ${error.message}`);
  return count ?? 0;
}

async function minMax(table: string, column: string): Promise<{ min: unknown; max: unknown }> {
  const [{ data: minData, error: minError }, { data: maxData, error: maxError }] = await Promise.all([
    supabaseAdmin.from(table).select(column).order(column, { ascending: true }).limit(1),
    supabaseAdmin.from(table).select(column).order(column, { ascending: false }).limit(1),
  ]);
  if (minError) throw new Error(`${table}.${column} min 조회 실패: ${minError.message}`);
  if (maxError) throw new Error(`${table}.${column} max 조회 실패: ${maxError.message}`);
  return {
    min: minData && minData.length > 0 ? (minData[0] as unknown as Record<string, unknown>)[column] : null,
    max: maxData && maxData.length > 0 ? (maxData[0] as unknown as Record<string, unknown>)[column] : null,
  };
}

async function distinctCount(table: string, column: string): Promise<number> {
  const seen = new Set<string>();
  let from = 0;
  const PAGE = 5000;
  for (;;) {
    const { data, error } = await supabaseAdmin.from(table).select(column).range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}.${column} distinct 조회 실패: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const row of data) {
      const value = (row as unknown as Record<string, unknown>)[column];
      if (value !== null && value !== undefined) seen.add(String(value));
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return seen.size;
}

async function reportTable(label: string, table: string, dateColumn: string, codeColumn: string): Promise<void> {
  console.log(`\n--- ${label}(${table}) ---`);
  const exists = await checkTableExists(table);
  if (!exists) return;
  const total = await countExact(table);
  console.log(`  총 행 수: ${total.toLocaleString()}`);
  if (total === 0) {
    console.log("  (비어있음)");
    return;
  }
  const { min, max } = await minMax(table, dateColumn);
  console.log(`  ${dateColumn} 범위: ${min} ~ ${max}`);
  const distinctCodes = await distinctCount(table, codeColumn);
  console.log(`  ${codeColumn} distinct 개수: ${distinctCodes.toLocaleString()}`);
}

async function reportBackfillRuns(): Promise<void> {
  console.log(`\n--- stock_data_backfill_runs(구 dh_backfill_runs) 실행 이력 ---`);
  const exists = await checkTableExists("stock_data_backfill_runs");
  if (!exists) return;

  const { data, error } = await supabaseAdmin
    .from("stock_data_backfill_runs")
    .select("data_source, last_completed_date, started_at, finished_at, rows_fetched, error_count")
    .order("started_at", { ascending: false });
  if (error) throw new Error(`stock_data_backfill_runs 조회 실패: ${error.message}`);

  console.log(`  총 실행 기록 수: ${data?.length ?? 0}`);

  const latestBySource = new Map<string, (typeof data)[number]>();
  for (const row of data ?? []) {
    if (!latestBySource.has(row.data_source)) latestBySource.set(row.data_source, row);
  }
  console.log("  data_source별 마지막 실행:");
  for (const [source, row] of latestBySource) {
    const status = row.finished_at === null ? "미완료(중단 추정)" : row.error_count > 0 ? `부분완료(실패 ${row.error_count}건)` : "성공";
    console.log(
      `    [${source}] 시작=${row.started_at} 종료=${row.finished_at ?? "null"} last_completed_date=${row.last_completed_date} rows_fetched=${row.rows_fetched} → ${status}`
    );
  }

  // 특히 사용자가 물어본 krx_price(전종목 일별시세 1단계)의 전체 이력을 다 보여준다
  // (여러 번 재개됐을 가능성이 높아서).
  const krxRuns = (data ?? []).filter((r) => r.data_source === "krx_price");
  console.log(`\n  krx_price(전종목 일별시세) 전체 실행 이력(${krxRuns.length}건, 최신순):`);
  for (const row of krxRuns) {
    console.log(`    시작=${row.started_at} 종료=${row.finished_at ?? "null"} last_completed_date=${row.last_completed_date} rows_fetched=${row.rows_fetched} error_count=${row.error_count}`);
  }
}

async function reportStorageBucket(): Promise<void> {
  console.log(`\n--- stock-daily-prices 버킷(Storage, 연도별 Parquet — 구 dh-daily-prices) ---`);
  const { data, error } = await supabaseAdmin.storage.from("stock-daily-prices").list("", { limit: 1000 });
  if (error) {
    console.log(`  조회 실패(버킷 없음 가능): ${error.message}`);
    return;
  }
  const years = (data ?? [])
    .map((f) => f.name)
    .filter((name) => /^\d{4}\.parquet$/.test(name))
    .map((name) => Number(name.slice(0, 4)))
    .sort((a, b) => a - b);
  console.log(`  존재하는 연도 파일 수: ${years.length}개`);
  console.log(`  연도 목록: ${JSON.stringify(years)}`);
  if (years.length > 0) {
    console.log(`  범위: ${years[0]} ~ ${years[years.length - 1]}`);
    // 연속 구간에 빠진 연도가 있는지 확인.
    const missing: number[] = [];
    for (let y = years[0]; y <= years[years.length - 1]; y++) {
      if (!years.includes(y)) missing.push(y);
    }
    if (missing.length > 0) console.log(`  범위 내 빠진 연도: ${JSON.stringify(missing)}`);
  }

  // 옛 버킷(dh-daily-prices)이 아직 남아있는지도 참고로 확인(정리 이력 확인용).
  const { data: oldBucketData, error: oldBucketError } = await supabaseAdmin.storage.from("dh-daily-prices").list("", { limit: 10 });
  if (oldBucketError) {
    console.log(`  (참고) 구 버킷 dh-daily-prices: 없음/접근불가(${oldBucketError.message}) — 정리된 것으로 보임`);
  } else {
    console.log(`  (참고) 구 버킷 dh-daily-prices: 아직 존재, 파일 ${oldBucketData?.length ?? 0}개`);
  }
}

async function reportBetaPriceHistory(): Promise<void> {
  console.log(`\n--- beta_price_history(RIM 1단계용, 목적 다름 — 참고 비교용) ---`);
  const exists = await checkTableExists("beta_price_history");
  if (!exists) return;
  const total = await countExact("beta_price_history");
  console.log(`  총 행 수: ${total.toLocaleString()} (코스피/코스닥 지수 2종목, 최근 3년치만 — 15년 전종목 백필과 목적/범위가 다름)`);
  if (total > 0) {
    const { min, max } = await minMax("beta_price_history", "trade_date");
    console.log(`  trade_date 범위: ${min} ~ ${max}`);
    const distinctMarkets = await distinctCount("beta_price_history", "market");
    console.log(`  market distinct 개수: ${distinctMarkets}`);
  }
}

async function main(): Promise<void> {
  console.log("########## 1. dh_daily_market_data (원래 이름) ##########");
  const dhDailyMarketDataExists = await checkTableExists("dh_daily_market_data");
  console.log(`  결론: ${dhDailyMarketDataExists ? "존재함(예상 밖 — 재확인 필요)" : "존재하지 않음(마이그레이션 이력상 DROP됨, 예상대로)"}`);

  console.log("\n########## 2. 후속 아키텍처(Storage Parquet + hot 테이블)로 대체된 부분 ##########");
  await reportTable("stock_daily_prices_recent(hot, 최근 2년)", "stock_daily_prices_recent", "trade_date", "stock_code");
  await reportStorageBucket();

  console.log("\n########## 3. dh_annual_fundamentals → stock_annual_fundamentals ##########");
  await reportTable("stock_annual_fundamentals", "stock_annual_fundamentals", "fiscal_year", "stock_code");

  console.log("\n########## 4. dh_dividend_history → stock_dividend_history ##########");
  await reportTable("stock_dividend_history", "stock_dividend_history", "record_date", "stock_code");

  console.log("\n########## 5. dh_backfill_runs → stock_data_backfill_runs ##########");
  await reportBackfillRuns();

  console.log("\n########## 6. beta_price_history(참고, 목적 다름) ##########");
  await reportBetaPriceHistory();

  console.log("\n=== 확인 종료 ===");
}

main().catch((error) => {
  console.error("확인 스크립트 실행 중 오류:", error);
  process.exit(1);
});
