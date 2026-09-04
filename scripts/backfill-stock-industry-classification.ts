/**
 * 관심종목 적정주가 방법A(업종 평균 PER)에 필요한 종목별 업종 분류 백필. 후보종목
 * (시가총액 1조원 이상 이력 있는 종목, ~300개)의 DART company.json(기업개황)을
 * 호출해 induty_code를 가져오고, 앞 2자리(KSIC 대분류,
 * lib/industryPerConfig.ts의 INDUSTRY_GROUP_KSIC_PREFIX_LENGTH)로 묶은
 * induty_group을 stock_industry_classification에 저장한다.
 *
 * DART가 burst rate limit에 민감했던 실측 이력(scripts/backfill-dart-cashflow-debt.ts
 * 주석 참고)이 있어 동시성을 낮게(2), 재시도 간격을 지수 백오프로 잡는다.
 *
 * server-only로 막힌 lib/supabaseAdmin.ts를 순수 Node 스크립트에서도 재사용하려면
 * "react-server" 조건으로 실행해야 한다:
 *   tsx --conditions=react-server scripts/backfill-stock-industry-classification.ts
 *
 * 필요 환경변수: DART_API_KEY, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { discoverCandidateStockCodes } from "@/lib/stockDailyPricesStorage";
import { STOCK_DATA_CANDIDATE_MARKET_CAP_EOK } from "@/lib/stockDataConfig";
import { fetchCompanyOverview } from "@/lib/dart";
import { INDUSTRY_GROUP_KSIC_PREFIX_LENGTH } from "@/lib/industryPerConfig";
import { upsertStockIndustryClassifications, type StockIndustryRow } from "@/lib/industryClassificationStorage";

const DATA_SOURCE = "dart_industry_classification" as const;
// scripts/backfill-dart-cashflow-debt.ts와 동일한 값(2026-09-03 실측 이력 반영).
const CONCURRENCY = 2;
const CALL_RETRY_COUNT = 3;
const CALL_RETRY_BASE_DELAY_MS = 5000;

// 1단계(scripts/backfill-stock-daily-prices.ts)의 BACKFILL_START_YEAR와 동일해야
// 후보종목이 빠짐없이 뽑힌다.
const PRICE_BACKFILL_START_YEAR = 2011;

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

async function discoverCandidates(): Promise<string[]> {
  const currentYear = new Date().getUTCFullYear();
  const years = Array.from(
    { length: currentYear - PRICE_BACKFILL_START_YEAR + 1 },
    (_, i) => PRICE_BACKFILL_START_YEAR + i
  );
  return discoverCandidateStockCodes(years, STOCK_DATA_CANDIDATE_MARKET_CAP_EOK);
}

async function getCorpCodeMap(stockCodes: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const CHUNK = 500;
  for (let i = 0; i < stockCodes.length; i += CHUNK) {
    const chunk = stockCodes.slice(i, i + CHUNK);
    const { data, error } = await supabaseAdmin
      .from("dart_corp_codes")
      .select("stock_code, corp_code")
      .in("stock_code", chunk);
    if (error) throw new Error(`corp_code 조회 실패: ${error.message}`);
    for (const row of data ?? []) {
      if (row.stock_code) map.set(row.stock_code, row.corp_code);
    }
  }
  return map;
}

async function fetchWithRetry(corpCode: string): Promise<string | null> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= CALL_RETRY_COUNT; attempt++) {
    try {
      const overview = await fetchCompanyOverview(corpCode);
      return overview.indutyCode;
    } catch (error) {
      lastError = error;
      // 지수 백오프(5초, 10초, 20초) — scripts/backfill-dart-cashflow-debt.ts와 동일한
      // burst rate limit 대응 패턴.
      if (attempt < CALL_RETRY_COUNT) await sleep(CALL_RETRY_BASE_DELAY_MS * 2 ** attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function main(): Promise<void> {
  const startedAt = new Date();

  console.log("후보종목 발굴 중...");
  const candidates = await discoverCandidates();
  console.log(`후보종목 ${candidates.length}개`);

  const corpCodeMap = await getCorpCodeMap(candidates);
  console.log(`corp_code 매핑 확인된 종목 ${corpCodeMap.size}개 (매핑 안 된 ${candidates.length - corpCodeMap.size}개는 건너뜀)`);

  const targets = candidates
    .map((stockCode) => ({ stockCode, corpCode: corpCodeMap.get(stockCode) }))
    .filter((t): t is { stockCode: string; corpCode: string } => t.corpCode !== undefined);

  const results: StockIndustryRow[] = [];
  let errorCount = 0;
  let completed = 0;

  await runWithConcurrency(targets, CONCURRENCY, async (target) => {
    try {
      const indutyCode = await fetchWithRetry(target.corpCode);
      const indutyGroup = indutyCode ? indutyCode.slice(0, INDUSTRY_GROUP_KSIC_PREFIX_LENGTH) : null;
      results.push({ stockCode: target.stockCode, corpCode: target.corpCode, indutyCode, indutyGroup });
    } catch (error) {
      errorCount++;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  ${target.stockCode} 실패: ${message}`);
    } finally {
      completed++;
      if (completed % 50 === 0 || completed === targets.length) {
        console.log(`진행: ${completed}/${targets.length}건 (성공 ${results.length}, 실패 ${errorCount})`);
      }
    }
  });

  await upsertStockIndustryClassifications(results);

  const { error: checkpointError } = await supabaseAdmin.from("stock_data_backfill_runs").insert({
    data_source: DATA_SOURCE,
    last_completed_date: null,
    started_at: startedAt.toISOString(),
    finished_at: new Date().toISOString(),
    rows_fetched: results.length,
    error_count: errorCount,
  });
  if (checkpointError) console.error(`체크포인트 저장 실패: ${checkpointError.message}`);

  console.log(`업종 분류 백필 완료: ${results.length}건 저장, 실패 ${errorCount}건(다음 실행에서 재시도됨)`);
}

main().catch((error) => {
  console.error("백필 중 오류:", error);
  process.exit(1);
});
