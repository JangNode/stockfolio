/**
 * (임시) scripts/backfill-dart-cashflow-debt.ts 최초 실행(2026-09-03) 결과를 검증한다.
 * 워크플로 요약 로그에 "채움 2629건, 데이터없음 341건, 실패 560건"이 나왔는데, 실패
 * 560건(약 16%)의 정확한 에러 메시지는 GitHub Actions 로그 조회 도구의 반환 크기
 * 제한 때문에 이 세션에서 확인하지 못했다 — 대신 DB에 실제로 쌓인 데이터를 직접
 * 조회해서 전체 커버리지(행 개수, fs_div 분포, 필드별 null 비율)를 확인한다.
 *
 * DB에는 아무것도 쓰지 않는 읽기 전용 진단 — 확인 끝나면 정리 PR에서 스크립트/
 * 워크플로와 함께 삭제한다.
 *
 * 필요 환경변수: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   tsx --conditions=react-server scripts/diagnose-dart-cashflow-debt-coverage.ts
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";

async function countRows(table: string): Promise<number> {
  const { count, error } = await supabaseAdmin.from(table).select("*", { count: "exact", head: true });
  if (error) throw new Error(`${table} 카운트 실패: ${error.message}`);
  return count ?? 0;
}

async function countWhereNull(table: string, column: string): Promise<number> {
  const { count, error } = await supabaseAdmin
    .from(table)
    .select("*", { count: "exact", head: true })
    .is(column, null);
  if (error) throw new Error(`${table}.${column} null 카운트 실패: ${error.message}`);
  return count ?? 0;
}

async function main(): Promise<void> {
  console.log("=== dart_cashflow_statements / dart_debt_structure 커버리지 진단 ===\n");

  const cashflowTotal = await countRows("dart_cashflow_statements");
  const debtTotal = await countRows("dart_debt_structure");
  console.log(`dart_cashflow_statements 전체 행: ${cashflowTotal}`);
  console.log(`dart_debt_structure 전체 행: ${debtTotal}\n`);

  console.log("--- fs_div 분포(dart_cashflow_statements) ---");
  for (const fsDiv of ["CFS", "OFS"]) {
    const { count, error } = await supabaseAdmin
      .from("dart_cashflow_statements")
      .select("*", { count: "exact", head: true })
      .eq("fs_div", fsDiv);
    if (error) throw new Error(error.message);
    console.log(`  ${fsDiv}: ${count ?? 0}건`);
  }

  console.log("\n--- dart_cashflow_statements 필드별 null 비율 ---");
  for (const col of ["operating_cf", "investing_cf", "capex", "financing_cf"]) {
    const nullCount = await countWhereNull("dart_cashflow_statements", col);
    console.log(`  ${col}: null ${nullCount}/${cashflowTotal}건 (${((nullCount / cashflowTotal) * 100).toFixed(1)}%)`);
  }

  console.log("\n--- dart_debt_structure 필드별 null 비율 ---");
  for (const col of ["short_term_debt", "long_term_debt", "bonds_payable", "interest_expense"]) {
    const nullCount = await countWhereNull("dart_debt_structure", col);
    console.log(`  ${col}: null ${nullCount}/${debtTotal}건 (${((nullCount / debtTotal) * 100).toFixed(1)}%)`);
  }

  console.log("\n--- 최근 백필 실행(stock_data_backfill_runs, data_source=dart_cashflow_debt) ---");
  const { data: runs, error: runsError } = await supabaseAdmin
    .from("stock_data_backfill_runs")
    .select("started_at, finished_at, rows_fetched, error_count")
    .eq("data_source", "dart_cashflow_debt")
    .order("started_at", { ascending: false })
    .limit(3);
  if (runsError) throw new Error(runsError.message);
  for (const r of runs ?? []) {
    console.log(`  started_at=${r.started_at} finished_at=${r.finished_at} rows_fetched=${r.rows_fetched} error_count=${r.error_count}`);
  }

  console.log("\n--- 샘플 종목(삼성전자/SK하이닉스/현대차) 존재 여부 ---");
  for (const code of ["005930", "000660", "005380"]) {
    const { data, error } = await supabaseAdmin
      .from("dart_cashflow_statements")
      .select("fiscal_year, fs_div")
      .eq("stock_code", code)
      .order("fiscal_year", { ascending: true });
    if (error) throw new Error(error.message);
    console.log(`  ${code}: ${(data ?? []).map((r) => `FY${r.fiscal_year}(${r.fs_div})`).join(", ") || "없음"}`);
  }

  console.log("\n=== 진단 종료 ===");
}

main().catch((error) => {
  console.error("진단 스크립트 실행 중 오류:", error);
  process.exit(1);
});
