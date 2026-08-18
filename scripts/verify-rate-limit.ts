/**
 * (임시) lib/kis.ts 토큰버킷/우선순위 큐 도입 후 실제 KIS API로 검증하는 1회성
 * 스크립트. DB에 쓰지 않고 콘솔에만 출력하며, 확인이 끝나면 지운다.
 *
 * tsx --conditions=react-server scripts/verify-rate-limit.ts
 *
 * 필요 환경변수: KIS_APP_KEY, KIS_APP_SECRET, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * (getAccessToken이 kis_tokens 테이블을 공유 캐시로 쓰므로 Supabase 자격증명도 필요하다.)
 */

import { getAllStocks } from "@/lib/stockMaster";
import { getDailyPrices, getKisCallStats, getStockPrice } from "@/lib/kis";

const SAMPLE_SIZE = 100;
// 알려진 유동성 큰 종목 10개 — 서로 종가가 다르다는 걸로 동시 호출 간 데이터가
// 뒤섞이지 않는지 확인하는 데 쓴다.
const DISTINCT_CHECK_CODES = [
  "005930", // 삼성전자
  "000660", // SK하이닉스
  "035420", // NAVER
  "005380", // 현대차
  "051910", // LG화학
  "006400", // 삼성SDI
  "035720", // 카카오
  "105560", // KB금융
  "012330", // 현대모비스
  "066570", // LG전자
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 같은 10종목을 순차(개념적으로 옛 방식과 동일한 "한 번에 하나씩" 접근)로 한 번,
 * 곧바로 동시(새 방식)로 한 번 더 조회해 건수가 같은지 비교한다. 5분 캐시
 * TTL 안에서 다시 조회하므로 두 번째 호출은 캐시 히트가 정상이다 — 그 자체로도
 * "동시 호출 패턴이어도 캐시가 깨지지 않는다"는 걸 보여준다.
 */
async function checkSequentialVsConcurrent(): Promise<{ mismatches: number }> {
  console.log("=== 1단계: 순차 vs 동시 조회 결과 비교 (10종목) ===");

  const sequential = new Map<string, number>();
  for (const code of DISTINCT_CHECK_CODES) {
    const prices = await getDailyPrices(code, "D", 50, "batch");
    sequential.set(code, prices.length);
  }

  const concurrent = await Promise.all(
    DISTINCT_CHECK_CODES.map((code) => getDailyPrices(code, "D", 50, "batch"))
  );

  let mismatches = 0;
  DISTINCT_CHECK_CODES.forEach((code, i) => {
    const seqLen = sequential.get(code);
    const concLen = concurrent[i].length;
    if (seqLen !== concLen) {
      mismatches++;
      console.error(`  불일치: ${code} 순차=${seqLen}건 동시=${concLen}건`);
    }
  });
  console.log(`  ${DISTINCT_CHECK_CODES.length}종목 비교 완료, 불일치 ${mismatches}건`);

  return { mismatches };
}

/** 서로 다른 종목을 동시에 조회했을 때 데이터가 섞이지 않는지(종가가 종목마다
 * 제각각인지) 확인한다. 만약 뒤섞이는 버그가 있다면 종가가 우연히 다 다를
 * 확률은 매우 낮으므로, 중복된 종가가 여럿 나오면 의심해봐야 한다. */
async function checkNoDataMixing(): Promise<{ duplicateClosePrices: number }> {
  console.log("=== 2단계: 동시 조회 시 종목 간 데이터 뒤섞임 확인 ===");

  const results = await Promise.all(
    DISTINCT_CHECK_CODES.map(async (code) => {
      const prices = await getDailyPrices(code, "D", 20, "batch");
      return { code, lastClose: prices[prices.length - 1]?.close };
    })
  );

  const closeCounts = new Map<number, string[]>();
  for (const { code, lastClose } of results) {
    if (lastClose === undefined) continue;
    const codes = closeCounts.get(lastClose) ?? [];
    codes.push(code);
    closeCounts.set(lastClose, codes);
  }

  let duplicateClosePrices = 0;
  for (const [price, codes] of closeCounts) {
    if (codes.length > 1) {
      duplicateClosePrices++;
      console.warn(`  주의: 종가 ${price}가 겹치는 종목: ${codes.join(", ")}`);
    }
  }

  console.log(
    `  ${results.map((r) => `${r.code}=${r.lastClose}`).join(", ")}`
  );
  console.log(`  종가 중복 ${duplicateClosePrices}건 (0이면 정상)`);

  return { duplicateClosePrices };
}

/** 종목 100개를 동시에(배치 우선순위) 조회해 rate limit 오류 없이 끝나는지,
 * 얼마나 걸리는지 확인한다. */
async function checkHundredStockBurst(): Promise<{
  elapsedMs: number;
  errors: number;
  succeeded: number;
}> {
  console.log(`=== 3단계: ${SAMPLE_SIZE}종목 동시 처리 (rate limit 오류 확인) ===`);

  const allStocks = await getAllStocks();
  const sample = allStocks.slice(0, SAMPLE_SIZE);

  let errors = 0;
  let succeeded = 0;
  const start = Date.now();

  await Promise.all(
    sample.map(async (stock) => {
      try {
        const prices = await getDailyPrices(stock.code, "D", 100, "batch");
        if (prices.length > 0) succeeded++;
      } catch (error) {
        errors++;
        const message = error instanceof Error ? error.message : String(error);
        console.error(`  ${stock.code}(${stock.name}) 실패: ${message}`);
      }
    })
  );

  const elapsedMs = Date.now() - start;
  console.log(
    `  ${sample.length}종목 처리: ${(elapsedMs / 1000).toFixed(1)}초, ` +
      `성공 ${succeeded}건, 실패 ${errors}건`
  );

  return { elapsedMs, errors, succeeded };
}

/**
 * 위 100종목 동시 처리가 진행되는 동안, 별도로 사용자(웹) 우선순위 요청을 주기적으로
 * 흘려보내 응답 지연이 허용 범위인지 확인한다. 배치가 큐를 꽉 채우고 있어도
 * 사용자 요청이 우선 처리되므로, 지연은 짧아야 한다(수백 ms 이내가 정상).
 */
async function checkUserLatencyDuringBatch(): Promise<{
  latenciesMs: number[];
}> {
  console.log("=== 4단계: 배치 진행 중 사용자 요청 지연 시뮬레이션 ===");

  const allStocks = await getAllStocks();
  // 3단계와 겹치지 않는 종목으로 새 배치 부하를 만든다.
  const busySample = allStocks.slice(SAMPLE_SIZE, SAMPLE_SIZE + 80).map((s) => s.code);

  const latenciesMs: number[] = [];

  const userSim = (async () => {
    for (let i = 0; i < 8; i++) {
      await sleep(400);
      const t0 = Date.now();
      try {
        await getStockPrice("005930", "user");
        latenciesMs.push(Date.now() - t0);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`  사용자 요청 실패: ${message}`);
      }
    }
  })();

  const batchLoad = Promise.all(
    busySample.map((code) =>
      getDailyPrices(code, "D", 100, "batch").catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`  (배치 부하) ${code} 실패: ${message}`);
      })
    )
  );

  await Promise.all([userSim, batchLoad]);

  const avg = latenciesMs.reduce((a, b) => a + b, 0) / (latenciesMs.length || 1);
  const max = latenciesMs.length > 0 ? Math.max(...latenciesMs) : 0;
  console.log(
    `  사용자 요청 ${latenciesMs.length}건 응답 지연: 평균 ${avg.toFixed(0)}ms, ` +
      `최대 ${max}ms, 목록 [${latenciesMs.join(", ")}]ms`
  );

  return { latenciesMs };
}

async function main(): Promise<void> {
  const startedAt = Date.now();

  const { mismatches } = await checkSequentialVsConcurrent();
  const { duplicateClosePrices } = await checkNoDataMixing();
  const { elapsedMs, errors, succeeded } = await checkHundredStockBurst();
  const { latenciesMs } = await checkUserLatencyDuringBatch();

  const totalElapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  const stats = getKisCallStats();

  console.log("=== 종합 ===");
  console.log(`총 소요 시간: ${totalElapsedSec}초`);
  console.log(`총 KIS 호출: ${stats.total}건 (EGW00201 재시도 ${stats.retried}건 포함)`);
  console.log(
    `100종목 동시 처리: 성공 ${succeeded}건, 실패 ${errors}건, ` +
      `${(elapsedMs / 1000).toFixed(1)}초`
  );
  console.log(`순차/동시 결과 불일치: ${mismatches}건`);
  console.log(`종가 중복(데이터 뒤섞임 의심): ${duplicateClosePrices}건`);
  const maxUserLatency = latenciesMs.length > 0 ? Math.max(...latenciesMs) : 0;
  console.log(`배치 진행 중 사용자 요청 최대 지연: ${maxUserLatency}ms`);

  const pass =
    mismatches === 0 && duplicateClosePrices === 0 && errors === 0 && maxUserLatency < 2000;
  console.log(pass ? "판정: 통과" : "판정: 실패 — 위 항목을 확인하세요");

  if (!pass) process.exit(1);
}

main().catch((error) => {
  console.error("검증 스크립트 실행 중 오류:", error);
  process.exit(1);
});
