/**
 * (임시) 2026-09-08 조건부 재백필 결과 확인용. 두 가지를 본다:
 * 1) 커버리지: stock_annual_fundamentals 총 종목 수(distinct stock_code), fs_div별
 *    행 수 — 사용자에게 보고할 "114개 종목에서 몇 개로 늘었는지" 답.
 * 2) 이번 재백필에서 채움 595건이 전부 fs_div='OFS'(CFS 0건)로 나온 게 이상해서,
 *    1차 진단(diagnose-dart-cfs-ofs-hypothesis.ts, 이미 삭제됨)에서 CFS로 실제
 *    데이터를 직접 확인했던 000030/039030/079430이 지금 DB에 어떻게 들어갔는지
 *    (fs_div가 뭔지, 아예 없는지) 확인해 진짜 버그인지 이번 배치 대상군의 특성인지
 *    가늠한다.
 *
 * 읽기 전용, DB만 조회하고 아무것도 쓰지 않는다. 확인 후 즉시 삭제 예정.
 * tsx --conditions=react-server scripts/diagnose-fundamentals-coverage-and-cfs-anomaly.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";

async function main(): Promise<void> {
  console.log("########## 1. 전체 커버리지 ##########");

  const allRows: { stock_code: string; fiscal_year: number; fs_div: string }[] = [];
  let from = 0;
  const PAGE = 1000;
  for (;;) {
    const { data, error } = await supabaseAdmin
      .from("stock_annual_fundamentals")
      .select("stock_code, fiscal_year, fs_div")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    allRows.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
    from += PAGE;
  }

  const distinctStocks = new Set(allRows.map((r) => r.stock_code));
  const cfsCount = allRows.filter((r) => r.fs_div === "CFS").length;
  const ofsCount = allRows.filter((r) => r.fs_div === "OFS").length;

  console.log(`  총 행 수: ${allRows.length}`);
  console.log(`  종목 수(distinct stock_code): ${distinctStocks.size}`);
  console.log(`  fs_div=CFS 행: ${cfsCount}, fs_div=OFS 행: ${ofsCount}`);

  console.log("\n########## 2. CFS 확인됐던 표본 종목 현재 상태 ##########");
  const sampleStocks = ["000030", "005270", "016360", "039030", "079430", "121800", "235980", "348340"];
  for (const stockCode of sampleStocks) {
    const rows = allRows.filter((r) => r.stock_code === stockCode).sort((a, b) => a.fiscal_year - b.fiscal_year);
    if (rows.length === 0) {
      console.log(`  ${stockCode}: DB에 없음(여전히 데이터없음이거나 미처리)`);
      continue;
    }
    const byDiv = rows.map((r) => `${r.fiscal_year}(${r.fs_div})`).join(", ");
    console.log(`  ${stockCode}: ${rows.length}건 — ${byDiv}`);
  }

  console.log("\n########## 3. 최근 백필 실행 기록 ##########");
  const { data: runs, error: runsError } = await supabaseAdmin
    .from("stock_data_backfill_runs")
    .select("data_source, started_at, finished_at, rows_fetched, error_count, status, total_targets, no_data_ratio, avg_response_time_ms")
    .eq("data_source", "dart_fundamentals")
    .order("started_at", { ascending: false })
    .limit(5);
  if (runsError) throw new Error(runsError.message);
  for (const run of runs ?? []) {
    console.log(`  ${run.started_at} ~ ${run.finished_at}: 채움 ${run.rows_fetched}, 실패 ${run.error_count}, status=${run.status}, target=${run.total_targets}, no_data_ratio=${run.no_data_ratio}, avg_ms=${run.avg_response_time_ms}`);
  }

  console.log("\n=== 확인 종료 ===");
}

main().catch((error) => {
  console.error("확인 중 오류:", error);
  process.exit(1);
});
