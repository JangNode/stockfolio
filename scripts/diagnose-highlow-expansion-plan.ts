/**
 * 사용자 요청: 급등주 찾기(reversal_breakout) 손절/익절 백테스트를 위해 고가/저가
 * 컬럼 추가가 필요한지, 필요하다면 규모(용량 증가분)를 확인한다. 시가/거래량 추가
 * 때(2026-09-06) 실측한 호출 수 추정(~8,180회, KRX 일일 한도 10,000회 안에서 1회
 * 실행으로 충분)은 이번에도 동일하게 적용되므로 재계산하지 않는다 — 이번엔 순수하게
 * "현재 고가/저가 컬럼 존재 여부"와 "현재 실측 Storage 용량"만 확인한다. 코드/스키마
 * 변경 없음 — 읽기 전용 1회성 확인, 확인 후 삭제 예정.
 *
 * 필요 환경변수: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   tsx --conditions=react-server scripts/diagnose-highlow-expansion-plan.ts
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";

const BUCKET = "stock-daily-prices";

async function main(): Promise<void> {
  console.log("########## 1. hot 테이블(stock_daily_prices_recent) 컬럼 확인 ##########");
  const { data, error } = await supabaseAdmin.from("stock_daily_prices_recent").select("*").limit(1);
  if (error) {
    console.log(`  조회 실패: ${error.message}`);
  } else {
    console.log(`  컬럼: ${data && data[0] ? Object.keys(data[0]).join(", ") : "(데이터 없음)"}`);
  }

  console.log("\n########## 2. stock-daily-prices 버킷 실제 파일 크기(현재, 시가/거래량 추가 이후) ##########");
  const { data: files, error: listError } = await supabaseAdmin.storage.from(BUCKET).list("", { limit: 1000 });
  if (listError) {
    console.log(`  조회 실패: ${listError.message}`);
    return;
  }
  const yearFiles = (files ?? []).filter((f) => /^\d{4}\.parquet$/.test(f.name));
  let totalBytes = 0;
  for (const f of yearFiles.sort((a, b) => a.name.localeCompare(b.name))) {
    const size = (f.metadata as { size?: number } | null)?.size ?? null;
    if (size !== null) totalBytes += size;
  }
  console.log(`  파일 수: ${yearFiles.length}, 총 용량: ${totalBytes.toLocaleString()} bytes (${(totalBytes / 1024 / 1024).toFixed(2)} MB)`);

  console.log("\n=== 확인 종료 ===");
}

main().catch((error) => {
  console.error("확인 스크립트 실행 중 오류:", error);
  process.exit(1);
});
