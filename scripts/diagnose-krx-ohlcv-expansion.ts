/**
 * 사용자 요청: 급등주 찾기(reversal_breakout) 15년 백테스트를 위해 stock-daily-prices
 * Storage(Parquet)에 시가(open)/거래량(volume)을 추가할 수 있는지 확인하는 계획 수립용
 * 진단. 코드/스키마 변경 없음 — 읽기 전용 1회성 확인, 확인 후 삭제 예정.
 *
 * 확인 항목:
 * 1. stock-daily-prices 버킷의 실제 파일 크기(바이트) — 컬럼 2개 추가 시 용량 증가분을
 *    실측 기준으로 추정하기 위함.
 * 2. reversal_breakout 전략이 지금까지 매칭한 적 있는 종목 수(screening_results ×
 *    strategies) — 시총 무관 예외 편입 후보군 크기 산정용. 이번 조사에서 커버리지
 *    0으로 확인된 3종목(에스트래픽/삼화왕관/HDC랩스)이 실제로 이 집합에 포함되는지도
 *    함께 확인.
 *
 * 필요 환경변수: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   tsx --conditions=react-server scripts/diagnose-krx-ohlcv-expansion.ts
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";

const BUCKET = "stock-daily-prices";
const ZERO_COVERAGE_CODES = [
  { name: "에스트래픽", code: "234300" },
  { name: "삼화왕관", code: "004450" },
  { name: "HDC랩스", code: "039570" },
];

async function reportBucketSizes(): Promise<void> {
  console.log(`########## 1. ${BUCKET} 버킷 실제 파일 크기 ##########`);
  const { data, error } = await supabaseAdmin.storage.from(BUCKET).list("", { limit: 1000 });
  if (error) {
    console.log(`  조회 실패: ${error.message}`);
    return;
  }

  const yearFiles = (data ?? []).filter((f) => /^\d{4}\.parquet$/.test(f.name));
  let totalBytes = 0;
  for (const f of yearFiles.sort((a, b) => a.name.localeCompare(b.name))) {
    const size = (f.metadata as { size?: number } | null)?.size ?? null;
    console.log(`  ${f.name}: ${size !== null ? `${size.toLocaleString()} bytes (${(size / 1024 / 1024).toFixed(2)} MB)` : "크기 정보 없음"}`);
    if (size !== null) totalBytes += size;
  }
  console.log(`  파일 수: ${yearFiles.length}, 총 용량: ${totalBytes.toLocaleString()} bytes (${(totalBytes / 1024 / 1024).toFixed(2)} MB)`);

  // 전체 프로젝트 Storage 사용량(다른 버킷 포함) 참고용.
  const { data: buckets, error: bucketsError } = await supabaseAdmin.storage.listBuckets();
  if (bucketsError) {
    console.log(`  버킷 목록 조회 실패: ${bucketsError.message}`);
  } else {
    console.log(`  프로젝트 전체 버킷: ${(buckets ?? []).map((b) => b.name).join(", ")}`);
  }
}

async function reportReversalBreakoutUniverse(): Promise<void> {
  console.log(`\n########## 2. reversal_breakout 매칭 이력 있는 종목(시총 무관 예외 편입 후보) ##########`);

  const { data: strategies, error: strategiesError } = await supabaseAdmin
    .from("strategies")
    .select("id, name")
    .eq("rule_type", "reversal_breakout");
  if (strategiesError) {
    console.log(`  전략 조회 실패: ${strategiesError.message}`);
    return;
  }
  if (!strategies || strategies.length === 0) {
    console.log(`  reversal_breakout 전략 자체가 없음`);
    return;
  }
  const strategyIds = strategies.map((s) => s.id);
  console.log(`  reversal_breakout 전략: ${strategies.map((s) => s.name).join(", ")} (${strategyIds.length}개)`);

  const { data: rows, error: rowsError } = await supabaseAdmin
    .from("screening_results")
    .select("stock_code, stock_name")
    .in("strategy_id", strategyIds);
  if (rowsError) {
    console.log(`  screening_results 조회 실패: ${rowsError.message}`);
    return;
  }

  const uniqueCodes = new Map<string, string>();
  for (const r of rows ?? []) uniqueCodes.set(r.stock_code, r.stock_name);
  console.log(`  지금까지 매칭된 적 있는 종목(active+종료 전부 포함) distinct 개수: ${uniqueCodes.size}`);
  console.log(`  전체 매칭 로그 행 수(중복 포함): ${rows?.length ?? 0}`);

  console.log(`\n  --- 이번 조사에서 시세 데이터 0건이었던 3종목의 매칭 이력 포함 여부 ---`);
  for (const { name, code } of ZERO_COVERAGE_CODES) {
    console.log(`  ${name}(${code}): ${uniqueCodes.has(code) ? "매칭 이력 있음 → 예외 편입 후보" : "매칭 이력도 없음(다른 경로로 확인 필요)"}`);
  }
}

async function main(): Promise<void> {
  await reportBucketSizes();
  await reportReversalBreakoutUniverse();
  console.log("\n=== 확인 종료 ===");
}

main().catch((error) => {
  console.error("확인 스크립트 실행 중 오류:", error);
  process.exit(1);
});
