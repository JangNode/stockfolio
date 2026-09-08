/**
 * (임시) 2026-09-08 CFS/OFS 가설 1차 진단(diagnose-dart-cfs-ofs-hypothesis.ts)에서
 * 뜻밖의 결과가 나왔다: 표본 8종목 모두 CFS/OFS 어느 쪽으로든 실제 데이터가
 * 존재하는데(039030은 CFS만으로 11개 연도), 정작 운영 백필(stock_annual_fundamentals)엔
 * 이 종목들이 0건이다 — CFS/OFS 구분 문제가 아니라 운영 스크립트 자체가 존재하는
 * 데이터도 못 가져왔다는 뜻이다.
 *
 * 새 가설: backfill-stock-annual-fundamentals.ts의 fetchFundamentals는
 *   if (body.status === "013" || !body.list || body.list.length === 0) return null;
 * 로 "013(데이터없음)"과 "list 필드가 없는 다른 모든 상태"를 구분하지 않는다.
 * DART는 020(요청 제한 초과 - 분당/일일)도 list 없이 내려오므로, 대량 연속 호출 중
 * rate limit에 걸리면 조용히 "데이터없음"으로 집계되고 에러로 올라가지 않을 수 있다.
 *
 * 이 스크립트는 운영 스크립트와 동일한 호출 패턴(동시성 2, 호출 간 별도 지연 없음,
 * 지수 백오프)으로 실제 target 목록의 앞부분을 재현하면서, 매 응답의 status 코드
 * 분포를 집계한다. 이미 1차 진단에서 실제 데이터가 존재함을 확인한 "컨트롤 쌍"
 * (000030/039030/079430의 알려진 연도)을 목록 곳곳에 끼워 넣어, 실행이 진행될수록
 * 이 알려진-존재하는 데이터가 013으로 둔갑하는지 직접 관찰한다.
 *
 * 읽기 전용, DART API만 호출하고 아무것도 쓰지 않는다. 확인 후 즉시 삭제 예정.
 * tsx --conditions=react-server scripts/diagnose-dart-status-code-masking.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { discoverCandidateStockCodes } from "@/lib/stockDailyPricesStorage";
import { STOCK_DATA_CANDIDATE_MARKET_CAP_EOK } from "@/lib/stockDataConfig";

const DART_BASE_URL = "https://opendart.fss.or.kr/api";
const FISCAL_YEAR_START = 2009;
const CONCURRENCY = 2;
const CALL_RETRY_COUNT = 3;
const CALL_RETRY_BASE_DELAY_MS = 5000;
const TARGET_LIMIT = 2500;
const CONTROL_INTERVAL = 150;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  let nextIndex = 0;
  async function runOne(): Promise<void> {
    for (;;) {
      const index = nextIndex++;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runOne));
}

interface DartAccountRow {
  rcept_no: string;
  sj_div: string;
  account_id: string;
  thstrm_amount: string;
}

interface CallOutcome {
  status: string | "NETWORK_ERROR";
  hasList: boolean;
}

// 운영 스크립트(fetchFundamentals)와 동일한 재시도/백오프 구조를 그대로 재현한다.
// 다만 실제 상태 코드를 그대로 반환해 "013으로 뭉뚱그려지는지"를 관찰한다.
async function callCfs(corpCode: string, fiscalYear: number, apiKey: string): Promise<CallOutcome> {
  const url = new URL(`${DART_BASE_URL}/fnlttSinglAcntAll.json`);
  url.searchParams.set("crtfc_key", apiKey);
  url.searchParams.set("corp_code", corpCode);
  url.searchParams.set("bsns_year", String(fiscalYear));
  url.searchParams.set("reprt_code", "11011");
  url.searchParams.set("fs_div", "CFS");

  let lastError: unknown;
  for (let attempt = 0; attempt <= CALL_RETRY_COUNT; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { status: string; list?: DartAccountRow[] };
      return { status: body.status, hasList: !!body.list && body.list.length > 0 };
    } catch (error) {
      lastError = error;
      if (attempt < CALL_RETRY_COUNT) await sleep(CALL_RETRY_BASE_DELAY_MS * 2 ** attempt);
    }
  }
  console.error(`  네트워크 에러(재시도 소진): ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  return { status: "NETWORK_ERROR", hasList: false };
}

interface Target {
  stockCode: string;
  corpCode: string;
  fiscalYear: number;
  isControl: boolean;
}

async function main(): Promise<void> {
  const apiKey = process.env.DART_API_KEY;
  if (!apiKey) throw new Error("DART_API_KEY 환경 변수가 없습니다.");

  console.log("########## 1. 운영 스크립트와 동일한 후보/target 재구성 ##########");
  const currentYear = new Date().getUTCFullYear();
  const priceYears = Array.from({ length: currentYear - 2011 + 1 }, (_, i) => 2011 + i);
  const candidates = await discoverCandidateStockCodes(priceYears, STOCK_DATA_CANDIDATE_MARKET_CAP_EOK);

  const { data: corpRows, error: corpError } = await supabaseAdmin
    .from("dart_corp_codes")
    .select("stock_code, corp_code")
    .in("stock_code", candidates);
  if (corpError) throw new Error(corpError.message);
  const corpMap = new Map<string, string>();
  for (const row of corpRows ?? []) {
    if (row.stock_code) corpMap.set(row.stock_code, row.corp_code);
  }

  const { data: fundRows, error: fundError } = await supabaseAdmin.from("stock_annual_fundamentals").select("stock_code, fiscal_year");
  if (fundError) throw new Error(fundError.message);
  const existingPairs = new Set((fundRows ?? []).map((r) => `${r.stock_code}:${r.fiscal_year}`));

  const fiscalYears = Array.from({ length: currentYear - FISCAL_YEAR_START }, (_, i) => FISCAL_YEAR_START + i);

  const targets: Target[] = [];
  for (const stockCode of candidates) {
    const corpCode = corpMap.get(stockCode);
    if (!corpCode) continue;
    for (const fiscalYear of fiscalYears) {
      if (!existingPairs.has(`${stockCode}:${fiscalYear}`)) {
        targets.push({ stockCode, corpCode, fiscalYear, isControl: false });
      }
    }
  }
  console.log(`  운영 스크립트 기준 실제 target ${targets.length}건 중 앞 ${Math.min(TARGET_LIMIT, targets.length)}건으로 재현`);
  const trimmed = targets.slice(0, TARGET_LIMIT);

  // 1차 진단에서 CFS로 실제 데이터가 확인된 (stockCode, fiscalYear) — 컨트롤 쌍.
  const controlPairs: { stockCode: string; fiscalYear: number }[] = [
    ...[2023, 2024, 2025].map((fiscalYear) => ({ stockCode: "000030", fiscalYear })),
    ...[2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025].map((fiscalYear) => ({ stockCode: "039030", fiscalYear })),
    ...[2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025].map((fiscalYear) => ({ stockCode: "079430", fiscalYear })),
  ];
  const controlCorp = new Map<string, string>();
  const { data: controlCorpRows, error: controlCorpError } = await supabaseAdmin
    .from("dart_corp_codes")
    .select("stock_code, corp_code")
    .in("stock_code", ["000030", "039030", "079430"]);
  if (controlCorpError) throw new Error(controlCorpError.message);
  for (const row of controlCorpRows ?? []) {
    if (row.stock_code) controlCorp.set(row.stock_code, row.corp_code);
  }

  // 컨트롤 쌍을 CONTROL_INTERVAL 간격으로 실행 순서 곳곳에 끼워 넣는다.
  const withControls: Target[] = [];
  let controlCursor = 0;
  for (let i = 0; i < trimmed.length; i++) {
    withControls.push(trimmed[i]);
    if (i > 0 && i % CONTROL_INTERVAL === 0 && controlCursor < controlPairs.length) {
      const pair = controlPairs[controlCursor++];
      const corpCode = controlCorp.get(pair.stockCode);
      if (corpCode) withControls.push({ stockCode: pair.stockCode, corpCode, fiscalYear: pair.fiscalYear, isControl: true });
    }
  }
  console.log(`  컨트롤 쌍 ${controlPairs.length}개를 ${CONTROL_INTERVAL}건 간격으로 삽입, 총 실행 ${withControls.length}건\n`);

  console.log("########## 2. 운영 스크립트와 동일 조건(동시성 2, 무지연)으로 재현 실행 ##########");
  const statusCounts = new Map<string, number>();
  let completed = 0;
  const controlResults: { stockCode: string; fiscalYear: number; status: string; hasList: boolean; atIndex: number }[] = [];
  const startedAt = Date.now();

  await runWithConcurrency(withControls, CONCURRENCY, async (target, index) => {
    const outcome = await callCfs(target.corpCode, target.fiscalYear, apiKey);
    statusCounts.set(outcome.status, (statusCounts.get(outcome.status) ?? 0) + 1);
    if (target.isControl) {
      controlResults.push({ stockCode: target.stockCode, fiscalYear: target.fiscalYear, status: outcome.status, hasList: outcome.hasList, atIndex: index });
      console.log(
        `  [컨트롤 #${index}] ${target.stockCode} FY${target.fiscalYear} -> status=${outcome.status} hasList=${outcome.hasList} (알려진 실제 데이터 존재 연도)`
      );
    }
    completed++;
    if (completed % 300 === 0 || completed === withControls.length) {
      const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(0);
      const dist = Array.from(statusCounts.entries())
        .map(([s, c]) => `${s}:${c}`)
        .join(", ");
      console.log(`  진행 ${completed}/${withControls.length}건 (${elapsedSec}s 경과) — 상태분포: ${dist}`);
    }
  });

  console.log("\n########## 3. 요약 ##########");
  console.log("  전체 상태 코드 분포:");
  for (const [status, count] of Array.from(statusCounts.entries()).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${status}: ${count}건`);
  }
  const controlFailures = controlResults.filter((r) => !(r.status === "000" && r.hasList));
  console.log(`\n  컨트롤 쌍 ${controlResults.length}개 중 실제로는 데이터가 있어야 하는데 이번엔 "없음"/에러로 나온 건: ${controlFailures.length}개`);
  for (const failure of controlFailures) {
    console.log(`    ${failure.stockCode} FY${failure.fiscalYear} (실행순서 #${failure.atIndex}) -> status=${failure.status}`);
  }
  console.log(`\n  총 호출 수(대략): ${completed}건`);
  console.log("\n=== 진단 종료 ===");
}

main().catch((error) => {
  console.error("진단 중 오류:", error);
  process.exit(1);
});
