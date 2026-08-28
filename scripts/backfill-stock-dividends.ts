/**
 * 종목 배당 원자료(여러 전략이 공유) 백필 3단계 — 후보종목(1단계가 Storage에 쓴
 * 연도별 Parquet 파일에서 시가총액 1조원 이상이었던 이력이 있는 종목)의 배당 이력을
 * stock_dividend_history에 채운다. 이미 검증된 lib/kis.ts의 getDividendRecords(예탁원정보/
 * 배당일정, payDate 포함)를 그대로 재사용한다 — 종목당 호출 1번으로 yearsBack년치가
 * 한 번에 온다.
 *
 * server-only로 막힌 lib/kis.ts, lib/supabaseAdmin.ts를 순수 Node 스크립트에서도
 * 재사용하려면 "react-server" 조건으로 실행해야 한다:
 *   tsx --conditions=react-server scripts/backfill-stock-dividends.ts
 *
 * 필요 환경변수: KIS_APP_KEY, KIS_APP_SECRET, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getDividendRecords } from "@/lib/kis";
import { discoverCandidateStockCodes } from "@/lib/stockDailyPricesStorage";
import { STOCK_DATA_CANDIDATE_MARKET_CAP_EOK } from "@/lib/stockDataConfig";

// 1단계(scripts/backfill-stock-daily-prices.ts)의 BACKFILL_START_YEAR와 동일해야
// 후보종목이 빠짐없이 뽑힌다.
const PRICE_BACKFILL_START_YEAR = 2011;
// 2011년 시작 백테스트의 5년 배당 lookback(2011년 초 조회 시 2006년까지 필요)까지
// 넉넉히 덮도록 여유를 둔다.
const DIVIDEND_YEARS_BACK = 20;
const CONCURRENCY = 8;

async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let nextIndex = 0;
  async function runOne(): Promise<void> {
    for (;;) {
      const index = nextIndex++;
      if (index >= items.length) return;
      await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runOne));
}

async function discoverCandidates(): Promise<string[]> {
  const currentYear = new Date().getUTCFullYear();
  const years = Array.from(
    { length: currentYear - PRICE_BACKFILL_START_YEAR + 1 },
    (_, i) => PRICE_BACKFILL_START_YEAR + i
  );
  return discoverCandidateStockCodes(years, STOCK_DATA_CANDIDATE_MARKET_CAP_EOK);
}

function toIsoDate(yyyymmdd: string): string {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

async function main(): Promise<void> {
  const startedAt = new Date();

  console.log("후보종목 발굴 중...");
  const candidates = await discoverCandidates();
  console.log(`후보종목 ${candidates.length}개`);

  let totalRecords = 0;
  let errorCount = 0;
  let completed = 0;

  await runWithConcurrency(candidates, CONCURRENCY, async (stockCode) => {
    try {
      const records = await getDividendRecords(stockCode, DIVIDEND_YEARS_BACK, "batch");
      if (records.length > 0) {
        const rows = records.map((r) => ({
          stock_code: stockCode,
          record_date: toIsoDate(r.recordDate),
          cash_dividend_per_share: r.cashDividendPerShare,
          pay_date: r.payDate ? toIsoDate(r.payDate) : null,
        }));
        const { error } = await supabaseAdmin.from("stock_dividend_history").upsert(rows);
        if (error) throw new Error(error.message);
        totalRecords += rows.length;
      }
    } catch (error) {
      errorCount++;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  ${stockCode} 배당 이력 조회 실패: ${message}`);
    } finally {
      completed++;
      if (completed % 50 === 0 || completed === candidates.length) {
        console.log(`진행: ${completed}/${candidates.length}종목 (누적 ${totalRecords}건, 실패 ${errorCount})`);
      }
    }
  });

  const { error: checkpointError } = await supabaseAdmin.from("stock_data_backfill_runs").insert({
    data_source: "dividends",
    last_completed_date: null,
    started_at: startedAt.toISOString(),
    finished_at: new Date().toISOString(),
    rows_fetched: totalRecords,
    error_count: errorCount,
  });
  if (checkpointError) console.error(`체크포인트 저장 실패: ${checkpointError.message}`);

  console.log(`배당 이력 백필 완료: 누적 ${totalRecords}건, 실패 ${errorCount}종목(다음 실행에서 재시도됨)`);
}

main().catch((error) => {
  console.error("백필 중 오류:", error);
  process.exit(1);
});
