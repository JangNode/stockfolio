/**
 * 디스포저블 진단: hot table 시가총액 하한 필터 복원(#423)이 실제 스크리닝
 * 배치 실행에서 작동했는지 확인한다. 쓰기 없음(순수 조회).
 *
 * 1. stock_daily_prices_recent의 최신 거래일 + 그날 행 수(예상: 수백 행,
 *    2,600행 안팎이면 필터가 안 먹은 것).
 * 2. 그 거래일 행 중 옛 필터 범위(5천억 미달 + 테마 소속 아님) 밖 종목 존재 여부.
 * 3. 그 거래일 행의 거래대금이 채워졌는지(0이 아님).
 * 4. screening_runs 최신 실행의 scanned_count/matched_count를 전일과 비교.
 *
 * 실행: npm run diagnose:hot-table-filter-revert-verify
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getThemeFlaggedStockCodes } from "@/lib/stockMaster";
import { STOCK_DATA_BACKFILL_MARKET_CAP_FLOOR_EOK } from "@/lib/stockDataConfig";

const HOT_TABLE = "stock_daily_prices_recent";
const PAGE_SIZE = 1000;

async function main(): Promise<void> {
  console.log("=== 1. stock_daily_prices_recent 최신 거래일 확인 ===");
  const { data: latestRow, error: latestError } = await supabaseAdmin
    .from(HOT_TABLE)
    .select("trade_date")
    .order("trade_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestError) throw new Error(`최신 거래일 조회 실패: ${latestError.message}`);
  const latestDate = (latestRow as { trade_date: string } | null)?.trade_date;
  if (!latestDate) {
    console.log("행이 없습니다.");
    return;
  }
  console.log(`최신 거래일: ${latestDate}`);

  type Row = {
    stock_code: string;
    market_cap_eok: number;
    trading_value: number | null;
  };
  const rows: Row[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabaseAdmin
      .from(HOT_TABLE)
      .select("stock_code, market_cap_eok, trading_value")
      .eq("trade_date", latestDate)
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`최신 거래일 행 조회 실패: ${error.message}`);
    rows.push(...((data ?? []) as Row[]));
    if (!data || data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  console.log(`${latestDate} 행 수: ${rows.length}건`);
  if (rows.length >= 2000) {
    console.log("!!! 2,000건 이상 — 필터가 작동하지 않았을 가능성이 높습니다 !!!");
  } else {
    console.log("수백 건 범위 — 예상과 일치(필터 작동 추정).");
  }

  console.log("\n=== 2. 옛 필터 범위 밖 종목 확인 ===");
  const themeFlaggedCodes = await getThemeFlaggedStockCodes();
  const outOfRange = rows.filter(
    (r) => r.market_cap_eok < STOCK_DATA_BACKFILL_MARKET_CAP_FLOOR_EOK && !themeFlaggedCodes.has(r.stock_code)
  );
  console.log(`시가총액 5천억 미달 + 테마 소속 아님(필터 위반 후보): ${outOfRange.length}건`);
  for (const r of outOfRange.slice(0, 5)) {
    console.log(`  샘플: ${r.stock_code}, 시가총액 ${r.market_cap_eok}억`);
  }

  console.log("\n=== 3. 거래대금 채움 확인 ===");
  const missingTradingValue = rows.filter((r) => r.trading_value === null || r.trading_value === undefined);
  const zeroTradingValue = rows.filter((r) => r.trading_value === 0);
  console.log(`거래대금 NULL: ${missingTradingValue.length}건, 거래대금 0: ${zeroTradingValue.length}건 (전체 ${rows.length}건 중)`);

  console.log("\n=== 4. screening_runs 최신 2건 비교 ===");
  const { data: runs, error: runsError } = await supabaseAdmin
    .from("screening_runs")
    .select("started_at, finished_at, scanned_count, matched_count, error_count")
    .order("started_at", { ascending: false })
    .limit(2);
  if (runsError) throw new Error(`screening_runs 조회 실패: ${runsError.message}`);
  for (const run of runs ?? []) {
    const r = run as { started_at: string; finished_at: string; scanned_count: number; matched_count: number; error_count: number };
    console.log(`  ${r.started_at} ~ ${r.finished_at}: scanned=${r.scanned_count}, matched=${r.matched_count}, error=${r.error_count}`);
  }
}

main().catch((error) => {
  console.error("진단 중 오류:", error);
  process.exit(1);
});
