/**
 * 대형주(KIS 시가총액 1조원 이상)만 골라 DART 재무제표/배당 이력 캐시를 갱신하는 배치
 * 스크립트. 전체 종목(2,700개 안팎)에 DART를 다 부르는 대신, 이미 매일 KIS를 호출하는
 * 스크리닝 배치와 같은 방식으로 시가총액을 조회해 미리 걸러낸 종목에만 DART를 부른다.
 *
 * corp_code 매핑(sync-dart-corp-codes.ts)이 먼저 최신이어야 하므로, GitHub Actions에서
 * 그 배치 30분 뒤에 돈다(.github/workflows/sync-dart-financials.yml). KIS 일일 스크리닝
 * 배치(screening.yml)와는 완전히 별개 워크플로 — 훨씬 낮은 주기(주 1회)로 돈다.
 *
 *   tsx --conditions=react-server scripts/sync-dart-financials.ts
 *
 * 필요 환경변수: DART_API_KEY, KIS_APP_KEY, KIS_APP_SECRET, NEXT_PUBLIC_SUPABASE_URL,
 * SUPABASE_SERVICE_ROLE_KEY
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getStockPrice } from "@/lib/kis";
import { getAllStocks, type StockEntry } from "@/lib/stockMaster";
import { syncFinancialStatements, syncDividends, type StockCorpPair } from "@/lib/dart";

const MARKET_CAP_THRESHOLD_EOK = 10_000; // 1조원

// screen-all-stocks.ts와 동일한 값 — KIS 배치 우선순위 토큰버킷(초당 12건)을 채우기
// 충분한 동시성.
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

/** KIS 시가총액으로 대형주만 걸러내고, DART corp_code 매핑이 있는 종목만 남긴다. */
async function findLargeCapStocks(): Promise<StockCorpPair[]> {
  const stocks: StockEntry[] = await getAllStocks();
  console.log(`전종목(KOSPI+KOSDAQ) ${stocks.length}건 대상으로 시가총액 조회 시작`);

  // 시세 조회 시점에 상장주식수(lstn_stcn)도 같이 받아서 넘겨두면, 뒤에서
  // syncFinancialStatements가 EPS/BPS 계산을 위해 KIS를 다시 호출하지 않아도 된다.
  const largeCaps: { code: string; sharesOutstanding: number | null }[] = [];
  let fetchErrors = 0;

  await runWithConcurrency(stocks, BATCH_CONCURRENCY, async (stock) => {
    try {
      const price = await withRetry(() => getStockPrice(stock.code, "batch"), `${stock.code}(${stock.name}) 시세 조회`);
      if (price.marketCapEok >= MARKET_CAP_THRESHOLD_EOK) {
        largeCaps.push({ code: stock.code, sharesOutstanding: price.sharesOutstanding });
      }
    } catch (error) {
      fetchErrors++;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`  ${stock.code}(${stock.name}) 시세 조회 실패, 건너뜁니다: ${message}`);
    }
  });

  console.log(`시가총액 ${MARKET_CAP_THRESHOLD_EOK.toLocaleString("ko-KR")}억원 이상: ${largeCaps.length}건 (조회 실패 ${fetchErrors}건)`);

  const { data: corpRows, error } = await supabaseAdmin
    .from("dart_corp_codes")
    .select("stock_code, corp_code")
    .in(
      "stock_code",
      largeCaps.map((s) => s.code)
    );

  if (error) throw new Error(`dart_corp_codes 조회 실패: ${error.message}`);

  const corpByStock = new Map((corpRows ?? []).map((r) => [r.stock_code as string, r.corp_code as string]));
  const pairs: StockCorpPair[] = [];
  for (const s of largeCaps) {
    const corpCode = corpByStock.get(s.code);
    if (corpCode !== undefined) {
      pairs.push({ stockCode: s.code, corpCode, sharesOutstanding: s.sharesOutstanding });
    }
  }

  const unmapped = largeCaps.length - pairs.length;
  if (unmapped > 0) {
    console.warn(`  대형주 중 DART corp_code 매핑이 없는 종목 ${unmapped}건은 건너뜁니다.`);
  }

  return pairs;
}

async function main(): Promise<void> {
  console.log("DART 재무제표/배당 이력 갱신 배치 시작");

  const largeCaps = await findLargeCapStocks();
  console.log(`대형주(시가총액 1조원 이상, DART 매핑 있음) 종목 수: ${largeCaps.length}`);

  const { updatedYears, maxSuccessfulChunkSize, sharesOutstandingStats } = await syncFinancialStatements(largeCaps);
  console.log(`재무제표 갱신: ${updatedYears}개 (종목×연도) 행 upsert, 다중회사 조회 성공 최대 묶음 크기: ${maxSuccessfulChunkSize}`);
  console.log(
    `상장주식수 확보: KIS ${sharesOutstandingStats.kis}건 / DART 폴백 ${sharesOutstandingStats.dart}건 / 확보 실패 ${sharesOutstandingStats.unavailable}건`
  );

  const updatedDividends = await syncDividends(largeCaps);
  console.log(`배당 이력 갱신: ${updatedDividends}개 (종목×연도) 행 upsert`);

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count: callsLast24h } = await supabaseAdmin
    .from("dart_api_call_log")
    .select("id", { count: "exact", head: true })
    .gte("called_at", since);

  console.log(`최근 24시간 DART 총 호출 횟수(이 배치 포함): ${callsLast24h ?? "확인 불가"}`);
  console.log("DART 재무제표/배당 이력 갱신 배치 종료");
}

main().catch((error) => {
  console.error("DART 재무제표/배당 이력 갱신 배치 실행 중 오류가 발생했습니다:", error);
  process.exit(1);
});
