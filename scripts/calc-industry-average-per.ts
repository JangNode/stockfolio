/**
 * 관심종목 적정주가 방법A(업종 평균 PER)에 필요한 종목별 PER을 매일 1회
 * 계산(=조회)해 stock_industry_per에 저장한다(lib/industryPerSamplesStorage.ts).
 * API 라우트는 이 표만 조회하고 추가 KIS 호출을 하지 않는다.
 *
 * stock_industry_classification(scripts/backfill-stock-industry-classification.ts가
 * 채움)의 induty_group별로 종목을 묶고, 각 종목의 PER을 KIS 현재가 조회
 * (lib/kis.ts getStockPrice, "batch" 우선순위)로 가져와 그대로 저장한다.
 *
 * 업종 중앙값은 이 배치에서 미리 계산하지 않는다 — leave-one-out(자기 자신 제외)
 * 방식이라 종목마다 결과가 다르므로, 조회 시점에 API 라우트가
 * lib/peerPerValuation.ts로 계산한다(2026-09-04, 삼성전자처럼 업종 시총 비중이
 * 압도적인 대형주는 그룹 전체(자기 포함) 중앙값이 자기 PER과 일치해버리는 문제가
 * 확인돼 이렇게 바꿨다). 적자기업(PER 0 이하 또는 null)은 null로 저장해두면
 * 중앙값 계산 시 자동으로 표본에서 제외된다.
 *
 * server-only로 막힌 lib/supabaseAdmin.ts를 순수 Node 스크립트에서도 재사용하려면
 * "react-server" 조건으로 실행해야 한다:
 *   tsx --conditions=react-server scripts/calc-industry-average-per.ts
 *
 * 필요 환경변수: KIS_APP_KEY, KIS_APP_SECRET, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getStockPrice } from "@/lib/kis";
import { getAllStockIndustryClassifications } from "@/lib/industryClassificationStorage";
import { upsertStockIndustryPers, type StockIndustryPerRow } from "@/lib/industryPerSamplesStorage";

const DATA_SOURCE = "kis_industry_per" as const;
// 스크리닝 배치(scripts/screen-all-stocks.ts)와 동일한 근거 — lib/kis.ts의 배치
// 토큰버킷(초당 12건)을 채울 만큼만 있으면 된다.
const BATCH_CONCURRENCY = 10;
const CALL_RETRY_COUNT = 2;
const CALL_RETRY_DELAY_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= CALL_RETRY_COUNT; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < CALL_RETRY_COUNT) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`    [재시도 ${attempt + 1}/${CALL_RETRY_COUNT}] ${label}: ${message}`);
        await sleep(CALL_RETRY_DELAY_MS);
      }
    }
  }
  throw lastError;
}

async function main(): Promise<void> {
  const startedAt = new Date();

  console.log("업종 분류 로딩 중...");
  const classifications = await getAllStockIndustryClassifications();
  const groupCount = new Set(classifications.map((row) => row.indutyGroup).filter(Boolean)).size;
  console.log(`업종 그룹 ${groupCount}개, 종목 ${classifications.length}개`);

  const rows: StockIndustryPerRow[] = [];
  let errorCount = 0;
  let completed = 0;

  await runWithConcurrency(classifications, BATCH_CONCURRENCY, async (row) => {
    if (!row.indutyGroup) return;
    try {
      const price = await withRetry(() => getStockPrice(row.stockCode, "batch"), `getStockPrice(${row.stockCode})`);
      // 적자기업(PER null 또는 0 이하)은 업종 중앙값을 왜곡하므로 null로 저장해
      // 표본에서 제외되게 한다.
      const per = price.per !== null && price.per > 0 ? price.per : null;
      rows.push({ stockCode: row.stockCode, indutyGroup: row.indutyGroup!, per });
    } catch (error) {
      errorCount++;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  ${row.stockCode} PER 조회 실패: ${message}`);
    } finally {
      completed++;
      if (completed % 50 === 0 || completed === classifications.length) {
        console.log(`진행: ${completed}/${classifications.length}건 (실패 ${errorCount})`);
      }
    }
  });

  await upsertStockIndustryPers(rows);

  const validCount = rows.filter((r) => r.per !== null).length;
  console.log(`업종 PER 저장 완료: ${rows.length}종목(유효 PER ${validCount}건, 적자/조회실패 ${rows.length - validCount}건)`);

  const { error: checkpointError } = await supabaseAdmin.from("stock_data_backfill_runs").insert({
    data_source: DATA_SOURCE,
    last_completed_date: null,
    started_at: startedAt.toISOString(),
    finished_at: new Date().toISOString(),
    rows_fetched: rows.length,
    error_count: errorCount,
  });
  if (checkpointError) console.error(`체크포인트 저장 실패: ${checkpointError.message}`);
}

main().catch((error) => {
  console.error("업종 PER 계산 중 오류:", error);
  process.exit(1);
});
