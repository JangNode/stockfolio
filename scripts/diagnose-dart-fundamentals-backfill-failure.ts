/**
 * (임시) 2026-09-04 dart_fundamentals 백필 대량 실패(5,544건) 원인 진단.
 * 읽기 전용 — 아무것도 쓰지 않는다. 확인 후 즉시 삭제 예정.
 * tsx --conditions=react-server scripts/diagnose-dart-fundamentals-backfill-failure.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { discoverCandidateStockCodes } from "@/lib/stockDailyPricesStorage";
import { STOCK_DATA_CANDIDATE_MARKET_CAP_EOK } from "@/lib/stockDataConfig";

async function main(): Promise<void> {
  console.log("########## 1. stock_data_backfill_runs 이력 (dart_fundamentals / dart_cashflow_debt) ##########");
  const { data: runs, error: runsError } = await supabaseAdmin
    .from("stock_data_backfill_runs")
    .select("data_source, started_at, finished_at, rows_fetched, error_count")
    .in("data_source", ["dart_fundamentals", "dart_cashflow_debt"])
    .order("started_at", { ascending: true });
  if (runsError) throw new Error(runsError.message);
  for (const r of runs ?? []) {
    console.log(
      `  ${r.data_source} started=${r.started_at} finished=${r.finished_at} rows_fetched=${r.rows_fetched} error_count=${r.error_count}`
    );
  }

  console.log("\n########## 2. 현재 stock_annual_fundamentals 커버리지 ##########");
  const { data: fundRows, error: fundError } = await supabaseAdmin
    .from("stock_annual_fundamentals")
    .select("stock_code, fiscal_year");
  if (fundError) throw new Error(fundError.message);
  const stockCodes = new Set((fundRows ?? []).map((r) => r.stock_code));
  const fiscalYears = (fundRows ?? []).map((r) => r.fiscal_year);
  console.log(
    `  전체 행 수=${fundRows?.length ?? 0}, 종목 수=${stockCodes.size}, 회계연도 범위=${Math.min(...fiscalYears)}~${Math.max(...fiscalYears)}`
  );
  const nullBoth = (fundRows ?? []).length;
  const { count: nullCount } = await supabaseAdmin
    .from("stock_annual_fundamentals")
    .select("*", { count: "exact", head: true })
    .is("net_income_parent", null)
    .is("equity_parent", null);
  console.log(`  net_income_parent/equity_parent 둘 다 null인 행: ${nullCount ?? "조회 실패"}건 (전체 ${nullBoth}건 중)`);

  console.log("\n########## 3. 후보종목 재발굴 (2026-09-04 실행 시점과 동일 기준) ##########");
  const currentYear = new Date().getUTCFullYear();
  const years = Array.from({ length: currentYear - 2011 + 1 }, (_, i) => 2011 + i);
  const candidates = await discoverCandidateStockCodes(years, STOCK_DATA_CANDIDATE_MARKET_CAP_EOK);
  console.log(`  후보종목(시총 1조원 이상 이력) ${candidates.length}개`);
  console.log(`  이 중 stock_annual_fundamentals에 이미 데이터가 있는 종목: ${candidates.filter((c) => stockCodes.has(c)).length}개`);
  console.log(`  이 중 아예 데이터가 없는 종목: ${candidates.filter((c) => !stockCodes.has(c)).length}개`);

  console.log("\n########## 4. corp_code 매핑 커버리지 ##########");
  const CHUNK = 500;
  const corpCodeMap = new Map<string, string>();
  for (let i = 0; i < candidates.length; i += CHUNK) {
    const chunk = candidates.slice(i, i + CHUNK);
    const { data, error } = await supabaseAdmin.from("dart_corp_codes").select("stock_code, corp_code").in("stock_code", chunk);
    if (error) throw new Error(error.message);
    for (const row of data ?? []) if (row.stock_code) corpCodeMap.set(row.stock_code, row.corp_code);
  }
  console.log(`  후보종목 ${candidates.length}개 중 corp_code 매핑 있음: ${corpCodeMap.size}개, 없음: ${candidates.length - corpCodeMap.size}개`);
  const unmapped = candidates.filter((c) => !corpCodeMap.has(c));
  console.log(`  매핑 안 된 종목코드 샘플(최대 10개): ${unmapped.slice(0, 10).join(", ")}`);

  console.log("\n########## 5. 9/4 실패 사례로 언급된 종목의 corp_code 매핑 확인 ##########");
  const sampleFailedCodes = ["456040", "328130", "006740", "009970"];
  const { data: sampleMap, error: sampleError } = await supabaseAdmin
    .from("dart_corp_codes")
    .select("stock_code, corp_code, corp_name")
    .in("stock_code", sampleFailedCodes);
  if (sampleError) throw new Error(sampleError.message);
  for (const code of sampleFailedCodes) {
    const row = sampleMap?.find((r) => r.stock_code === code);
    console.log(`  ${code}: ${row ? `corp_code=${row.corp_code} (${row.corp_name})` : "corp_code 매핑 없음"}`);
    const existing = (fundRows ?? []).filter((r) => r.stock_code === code);
    console.log(`    stock_annual_fundamentals 기존 보유 회계연도: ${existing.map((r) => r.fiscal_year).sort().join(",") || "없음"}`);
  }

  console.log("\n=== 진단 종료 ===");
}

main().catch((error) => {
  console.error("진단 중 오류:", error);
  process.exit(1);
});
