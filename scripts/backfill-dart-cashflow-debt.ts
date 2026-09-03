/**
 * RIM/DCF 적정주가 계산용 선행 데이터(현금흐름표, 부채구조) 백필. 구조는
 * scripts/backfill-stock-annual-fundamentals.ts(1단계 재무 백필)와 동일하다 —
 * 후보종목(백필 기간 중 단 하루라도 시가총액 1조원을 넘은 적 있는 종목) ×
 * 최근 DART_VALUATION_FISCAL_YEARS개년 조합마다 DART fnlttSinglAcntAll(단일회사
 * 전체 재무제표)을 개별 호출해 dart_cashflow_statements/dart_debt_structure를 채운다.
 *
 * 연결재무제표(fs_div=CFS)를 우선 조회하고, 데이터가 없으면(status "013" 또는 빈
 * list) 별도재무제표(fs_div=OFS)로 재조회한다 — 어느 쪽으로 채워졌는지는 fs_div
 * 컬럼에 그대로 남긴다. 계정과목 매칭은 lib/dartValuationConfig.ts의 후보
 * account_id 목록에서 첫 매치만 쓴다 — 매치가 없으면 해당 필드는 null로 두고
 * console.warn만 남긴다(텍스트 유사 매칭으로 억지로 채우지 않는다).
 *
 * (stock_code, fiscal_year) 기본키라 이미 있는 조합은 idempotent하게 다시 채워도
 * 안전하지만, 재실행 비용을 줄이려고 두 표 모두에 이미 있는 조합은 호출 전에
 * 걸러낸다(한쪽 표에만 있는 경우는 다시 호출해 양쪽을 채운다).
 *
 * server-only로 막힌 lib/supabaseAdmin.ts를 순수 Node 스크립트에서도 재사용하려면
 * "react-server" 조건으로 실행해야 한다:
 *   tsx --conditions=react-server scripts/backfill-dart-cashflow-debt.ts
 *
 * 필요 환경변수: DART_API_KEY, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { discoverCandidateStockCodes } from "@/lib/stockDailyPricesStorage";
import { STOCK_DATA_CANDIDATE_MARKET_CAP_EOK } from "@/lib/stockDataConfig";
import {
  DART_VALUATION_FISCAL_YEARS,
  OPERATING_CF_ACCOUNT_IDS,
  INVESTING_CF_ACCOUNT_IDS,
  FINANCING_CF_ACCOUNT_IDS,
  CAPEX_ACCOUNT_IDS,
  SHORT_TERM_DEBT_ACCOUNT_IDS,
  LONG_TERM_DEBT_ACCOUNT_IDS,
  BONDS_PAYABLE_ACCOUNT_IDS,
  INTEREST_EXPENSE_ACCOUNT_IDS,
} from "@/lib/dartValuationConfig";

const DART_BASE_URL = "https://opendart.fss.or.kr/api";
const DATA_SOURCE = "dart_cashflow_debt" as const;
// 2026-09-03 최초 실행 실측: CONCURRENCY=8로 짧은 시간에 대량 호출(최대 3530건×
// 최대 2회(CFS/OFS))하니 "fetch failed"(네트워크 단계 오류, DART가 상태코드 없이
// 연결을 끊는 것으로 추정)가 발생했고, 재시도 2회/1.5초로는 회복되지 않았다. 곧바로
// 재실행하니 오히려 실패율이 더 올라갔다(560→842건, 16%→93%) — 짧은 재시도
// 간격이 아니라 API 키 단위의 일시적 제한(burst rate limit)일 가능성이 높다고
// 판단해, 동시성을 대폭 낮추고 재시도 간격을 지수 백오프로 늘렸다.
const CONCURRENCY = 2;
const CALL_RETRY_COUNT = 3;
const CALL_RETRY_BASE_DELAY_MS = 5000;

// 1단계(scripts/backfill-stock-daily-prices.ts)의 BACKFILL_START_YEAR와 동일해야
// 후보종목이 빠짐없이 뽑힌다(scripts/backfill-stock-annual-fundamentals.ts와 동일).
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

/** 백필 기간 중 단 하루라도 시가총액 1조원을 넘은 적 있는 종목을 뽑는다. 나중에
 * 스크리닝 대상 전체로 범위를 넓히고 싶으면 이 함수만 다른 조회 로직으로 바꾸면
 * 된다 — 시그니처(Promise<string[]> 반환)만 유지하면 스크립트의 나머지 부분(호출·
 * 매칭·저장 로직)은 그대로 재사용 가능하다. */
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

async function getExistingPairs(table: "dart_cashflow_statements" | "dart_debt_structure"): Promise<Set<string>> {
  const existing = new Set<string>();
  let from = 0;
  const PAGE = 1000;
  for (;;) {
    const { data, error } = await supabaseAdmin.from(table).select("stock_code, fiscal_year").range(from, from + PAGE - 1);
    if (error) throw new Error(`기존 ${table} 데이터 조회 실패: ${error.message}`);
    for (const row of data ?? []) existing.add(`${row.stock_code}:${row.fiscal_year}`);
    if (!data || data.length < PAGE) break;
    from += PAGE;
  }
  return existing;
}

interface DartAccountRow {
  rcept_no: string;
  sj_div: string;
  account_id: string;
  thstrm_amount: string;
}

interface FetchedStatements {
  rceptNo: string;
  rceptDate: string;
  fsDiv: "CFS" | "OFS";
  operatingCf: number | null;
  investingCf: number | null;
  financingCf: number | null;
  capex: number | null;
  shortTermDebt: number | null;
  longTermDebt: number | null;
  bondsPayable: number | null;
  interestExpense: number | null;
}

function findAmount(
  list: DartAccountRow[],
  sjDiv: string,
  candidateIds: string[],
  stockCode: string,
  fiscalYear: number,
  fieldName: string
): number | null {
  const row = list.find((r) => r.sj_div === sjDiv && candidateIds.includes(r.account_id));
  if (!row) {
    console.warn(`  계정과목 매칭 실패: stock_code=${stockCode} fiscal_year=${fiscalYear} field=${fieldName}`);
    return null;
  }
  return Number(row.thstrm_amount);
}

async function callSingleAcntAll(
  corpCode: string,
  fiscalYear: number,
  fsDiv: "CFS" | "OFS",
  apiKey: string
): Promise<DartAccountRow[] | null> {
  const url = new URL(`${DART_BASE_URL}/fnlttSinglAcntAll.json`);
  url.searchParams.set("crtfc_key", apiKey);
  url.searchParams.set("corp_code", corpCode);
  url.searchParams.set("bsns_year", String(fiscalYear));
  url.searchParams.set("reprt_code", "11011"); // 사업보고서
  url.searchParams.set("fs_div", fsDiv);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { status: string; list?: DartAccountRow[] };

  // status "013"은 "조회된 데이터가 없습니다" — 정상적인 "없음"으로 취급한다.
  if (body.status === "013" || !body.list || body.list.length === 0) return null;
  if (body.status !== "000") throw new Error(`DART 오류(${body.status})`);
  return body.list;
}

async function fetchStatements(
  stockCode: string,
  corpCode: string,
  fiscalYear: number,
  apiKey: string
): Promise<FetchedStatements | null> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= CALL_RETRY_COUNT; attempt++) {
    try {
      let list = await callSingleAcntAll(corpCode, fiscalYear, "CFS", apiKey);
      let fsDiv: "CFS" | "OFS" = "CFS";
      if (!list) {
        list = await callSingleAcntAll(corpCode, fiscalYear, "OFS", apiKey);
        fsDiv = "OFS";
      }
      if (!list) return null;

      const rceptNo = list[0].rcept_no;
      const rceptDate = `${rceptNo.slice(0, 4)}-${rceptNo.slice(4, 6)}-${rceptNo.slice(6, 8)}`;

      return {
        rceptNo,
        rceptDate,
        fsDiv,
        operatingCf: findAmount(list, "CF", OPERATING_CF_ACCOUNT_IDS, stockCode, fiscalYear, "operating_cf"),
        investingCf: findAmount(list, "CF", INVESTING_CF_ACCOUNT_IDS, stockCode, fiscalYear, "investing_cf"),
        financingCf: findAmount(list, "CF", FINANCING_CF_ACCOUNT_IDS, stockCode, fiscalYear, "financing_cf"),
        capex: findAmount(list, "CF", CAPEX_ACCOUNT_IDS, stockCode, fiscalYear, "capex"),
        shortTermDebt: findAmount(list, "BS", SHORT_TERM_DEBT_ACCOUNT_IDS, stockCode, fiscalYear, "short_term_debt"),
        longTermDebt: findAmount(list, "BS", LONG_TERM_DEBT_ACCOUNT_IDS, stockCode, fiscalYear, "long_term_debt"),
        bondsPayable: findAmount(list, "BS", BONDS_PAYABLE_ACCOUNT_IDS, stockCode, fiscalYear, "bonds_payable"),
        interestExpense: findAmount(
          list,
          "CF",
          INTEREST_EXPENSE_ACCOUNT_IDS,
          stockCode,
          fiscalYear,
          "interest_expense"
        ),
      };
    } catch (error) {
      lastError = error;
      // 지수 백오프(5초, 10초, 20초) — burst rate limit으로 추정되는 "fetch failed"가
      // 짧은 고정 간격 재시도로는 회복되지 않았던 실측 결과를 반영했다(위 상수 주석
      // 참고).
      if (attempt < CALL_RETRY_COUNT) await sleep(CALL_RETRY_BASE_DELAY_MS * 2 ** attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function main(): Promise<void> {
  const apiKey = process.env.DART_API_KEY;
  if (!apiKey) throw new Error("DART_API_KEY 환경 변수가 없습니다.");

  const startedAt = new Date();
  const currentYear = new Date().getFullYear();
  // 최신 연도는 아직 사업보고서가 안 나왔을 수 있어 제외(currentYear 미포함).
  const fiscalYears = Array.from(
    { length: DART_VALUATION_FISCAL_YEARS },
    (_, i) => currentYear - DART_VALUATION_FISCAL_YEARS + i
  );

  console.log("후보종목 발굴 중...");
  const candidates = await discoverCandidates();
  console.log(`후보종목 ${candidates.length}개 (시가총액 1조원 이상 이력 있는 종목)`);

  const corpCodeMap = await getCorpCodeMap(candidates);
  console.log(`corp_code 매핑 확인된 종목 ${corpCodeMap.size}개 (매핑 안 된 ${candidates.length - corpCodeMap.size}개는 건너뜀)`);

  const existingCashflowPairs = await getExistingPairs("dart_cashflow_statements");
  const existingDebtPairs = await getExistingPairs("dart_debt_structure");

  const targets: { stockCode: string; corpCode: string; fiscalYear: number }[] = [];
  for (const stockCode of candidates) {
    const corpCode = corpCodeMap.get(stockCode);
    if (!corpCode) continue;
    for (const fiscalYear of fiscalYears) {
      const key = `${stockCode}:${fiscalYear}`;
      // 두 표 모두에 이미 있는 조합만 건너뛴다 — 한쪽만 있으면 다시 호출해 채운다.
      if (existingCashflowPairs.has(key) && existingDebtPairs.has(key)) continue;
      targets.push({ stockCode, corpCode, fiscalYear });
    }
  }

  console.log(`처리 대상 ${targets.length}건 (양쪽 표 모두 이미 있는 조합은 건너뜀)`);
  if (targets.length === 0) {
    console.log("처리할 항목이 없습니다. 이미 최신 상태입니다.");
    return;
  }

  let fetched = 0;
  let skippedNoData = 0;
  let errorCount = 0;
  let completed = 0;

  await runWithConcurrency(targets, CONCURRENCY, async (target) => {
    try {
      const result = await fetchStatements(target.stockCode, target.corpCode, target.fiscalYear, apiKey);
      if (result) {
        const { error: cashflowError } = await supabaseAdmin.from("dart_cashflow_statements").upsert({
          stock_code: target.stockCode,
          corp_code: target.corpCode,
          fiscal_year: target.fiscalYear,
          fs_div: result.fsDiv,
          rcept_no: result.rceptNo,
          rcept_date: result.rceptDate,
          operating_cf: result.operatingCf,
          investing_cf: result.investingCf,
          capex: result.capex,
          financing_cf: result.financingCf,
        });
        if (cashflowError) throw new Error(cashflowError.message);

        const { error: debtError } = await supabaseAdmin.from("dart_debt_structure").upsert({
          stock_code: target.stockCode,
          corp_code: target.corpCode,
          fiscal_year: target.fiscalYear,
          fs_div: result.fsDiv,
          rcept_no: result.rceptNo,
          rcept_date: result.rceptDate,
          short_term_debt: result.shortTermDebt,
          long_term_debt: result.longTermDebt,
          bonds_payable: result.bondsPayable,
          interest_expense: result.interestExpense,
        });
        if (debtError) throw new Error(debtError.message);

        fetched++;
      } else {
        skippedNoData++;
      }
    } catch (error) {
      errorCount++;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  ${target.stockCode} FY${target.fiscalYear} 실패: ${message}`);
    } finally {
      completed++;
      if (completed % 200 === 0 || completed === targets.length) {
        console.log(`진행: ${completed}/${targets.length}건 (채움 ${fetched}, 데이터없음 ${skippedNoData}, 실패 ${errorCount})`);
      }
    }
  });

  const { error: checkpointError } = await supabaseAdmin.from("stock_data_backfill_runs").insert({
    data_source: DATA_SOURCE,
    last_completed_date: null,
    started_at: startedAt.toISOString(),
    finished_at: new Date().toISOString(),
    rows_fetched: fetched,
    error_count: errorCount,
  });
  if (checkpointError) console.error(`체크포인트 저장 실패: ${checkpointError.message}`);

  console.log(
    `DART 현금흐름/부채 백필 완료: 채움 ${fetched}건, 데이터없음 ${skippedNoData}건, 실패 ${errorCount}건 (실패분은 다음 실행에서 재시도됨)`
  );
}

main().catch((error) => {
  console.error("백필 중 오류:", error);
  process.exit(1);
});
