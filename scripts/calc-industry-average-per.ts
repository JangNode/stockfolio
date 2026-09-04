/**
 * 관심종목 적정주가 방법A(업종 평균 PER)에 필요한 업종 그룹별 PER 중앙값을 매일 1회
 * 계산해 industry_average_per에 저장한다(lib/industryAveragePerStorage.ts). API
 * 라우트는 이 표만 조회하고 추가 KIS 호출을 하지 않는다.
 *
 * stock_industry_classification(scripts/backfill-stock-industry-classification.ts가
 * 채움)의 induty_group별로 종목을 묶고, 각 종목의 PER을 KIS 현재가 조회
 * (lib/kis.ts getStockPrice, "batch" 우선순위)로 가져온다. 적자기업(PER 0 이하 또는
 * null)은 표본에서 제외한다 — 업종 평균이 적자기업의 왜곡된 PER로 오염되지 않게
 * 한다. 표본 수가 INDUSTRY_PEER_MIN_GROUP_SIZE 미만인 그룹은 median_per를
 * null로 저장한다(산출 불가 근거).
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
import { upsertIndustryAveragePer, type IndustryAveragePerRow } from "@/lib/industryAveragePerStorage";
import { INDUSTRY_PEER_MIN_GROUP_SIZE } from "@/lib/industryPerConfig";

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

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

async function main(): Promise<void> {
  const startedAt = new Date();

  console.log("업종 분류 로딩 중...");
  const classifications = await getAllStockIndustryClassifications();
  const codesByGroup = new Map<string, string[]>();
  for (const row of classifications) {
    if (!row.indutyGroup) continue;
    const list = codesByGroup.get(row.indutyGroup) ?? [];
    list.push(row.stockCode);
    codesByGroup.set(row.indutyGroup, list);
  }
  console.log(`업종 그룹 ${codesByGroup.size}개, 종목 ${classifications.length}개`);

  const perByCode = new Map<string, number | null>();
  const allCodes = classifications.map((row) => row.stockCode);
  let errorCount = 0;
  let completed = 0;

  await runWithConcurrency(allCodes, BATCH_CONCURRENCY, async (code) => {
    try {
      const price = await withRetry(() => getStockPrice(code, "batch"), `getStockPrice(${code})`);
      perByCode.set(code, price.per);
    } catch (error) {
      errorCount++;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  ${code} PER 조회 실패: ${message}`);
    } finally {
      completed++;
      if (completed % 50 === 0 || completed === allCodes.length) {
        console.log(`진행: ${completed}/${allCodes.length}건 (실패 ${errorCount})`);
      }
    }
  });

  const rows: IndustryAveragePerRow[] = [];
  for (const [indutyGroup, codes] of codesByGroup) {
    // 적자기업(PER null 또는 0 이하)은 업종 평균을 왜곡하므로 표본에서 제외한다.
    const positivePers = codes.map((code) => perByCode.get(code)).filter((per): per is number => per !== null && per !== undefined && per > 0);

    const peerCount = positivePers.length;
    const medianPer = peerCount >= INDUSTRY_PEER_MIN_GROUP_SIZE ? median(positivePers) : null;
    rows.push({ indutyGroup, medianPer, peerCount });
  }

  await upsertIndustryAveragePer(rows);

  const computedGroups = rows.filter((r) => r.medianPer !== null).length;
  console.log(`업종 평균 PER 계산 완료: ${rows.length}개 그룹 저장(산출 ${computedGroups}개, 표본부족 ${rows.length - computedGroups}개)`);

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
  console.error("업종 평균 PER 계산 중 오류:", error);
  process.exit(1);
});
