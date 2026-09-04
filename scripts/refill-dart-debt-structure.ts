/**
 * DCF 2단계(WACC) 착수 전 발견한 문제를 고친다: dart_debt_structure의
 * long_term_debt/bonds_payable이 대부분(77.8%/93.4%) null이었던 건 실제 부채가
 * 0이어서가 아니라 lib/dartValuationConfig.ts의 후보 account_id 목록이 삼성전자/
 * SK하이닉스/현대차 3사로만 확정돼 다른 업종의 계정과목 표기를 못 커버했기
 * 때문이다(scripts/diagnose-dart-debt-account-tags.ts로 40개 표본 재진단해 원인
 * 확인, 후보 목록 확장 완료).
 *
 * 이 스크립트는 기존 dart_debt_structure에서 short_term_debt/long_term_debt/
 * bonds_payable 중 하나라도 null인 (stock_code, fiscal_year) 조합을 골라
 * fnlttSinglAcntAll을 다시 호출하고, 확장된 후보 목록으로 재매칭해 upsert한다.
 * 이미 채워져 있던 값은 후보 목록에 항목만 추가했을 뿐(기존 매치는 그대로
 * 남아있음) 값이 바뀌지 않는다 — 새로 매치되는 필드만 채워진다.
 *
 * scripts/backfill-dart-cashflow-debt.ts와 동일한 호출/재시도 패턴을 쓴다
 * (CONCURRENCY=2, 지수 백오프 — 2026-09-03 burst rate limit 실측 이후 확정된 값).
 *
 * server-only로 막힌 lib/supabaseAdmin.ts를 순수 Node 스크립트에서도 재사용하려면
 * "react-server" 조건으로 실행해야 한다:
 *   tsx --conditions=react-server scripts/refill-dart-debt-structure.ts
 *
 * 필요 환경변수: DART_API_KEY, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  SHORT_TERM_DEBT_ACCOUNT_IDS,
  LONG_TERM_DEBT_ACCOUNT_IDS,
  BONDS_PAYABLE_ACCOUNT_IDS,
  INTEREST_EXPENSE_ACCOUNT_IDS,
} from "@/lib/dartValuationConfig";

const DART_BASE_URL = "https://opendart.fss.or.kr/api";
const DATA_SOURCE = "dart_cashflow_debt" as const;
// scripts/backfill-dart-cashflow-debt.ts 2026-09-03 실측 근거 그대로 재사용(burst
// rate limit로 CONCURRENCY=8은 실패, 2로 낮추고 지수 백오프해야 안정적이었음).
const CONCURRENCY = 2;
const CALL_RETRY_COUNT = 3;
const CALL_RETRY_BASE_DELAY_MS = 5000;

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

interface RefillTarget {
  stockCode: string;
  corpCode: string;
  fiscalYear: number;
}

interface DartAccountRow {
  rcept_no: string;
  sj_div: string;
  account_id: string;
  thstrm_amount: string;
}

function findAmount(list: DartAccountRow[], sjDiv: string, candidateIds: string[]): number | null {
  const row = list.find((r) => r.sj_div === sjDiv && candidateIds.includes(r.account_id));
  return row ? Number(row.thstrm_amount) : null;
}

async function callSingleAcntAll(corpCode: string, fiscalYear: number, fsDiv: "CFS" | "OFS", apiKey: string): Promise<DartAccountRow[] | null> {
  const url = new URL(`${DART_BASE_URL}/fnlttSinglAcntAll.json`);
  url.searchParams.set("crtfc_key", apiKey);
  url.searchParams.set("corp_code", corpCode);
  url.searchParams.set("bsns_year", String(fiscalYear));
  url.searchParams.set("reprt_code", "11011");
  url.searchParams.set("fs_div", fsDiv);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { status: string; list?: DartAccountRow[] };
  if (body.status === "013" || !body.list || body.list.length === 0) return null;
  if (body.status !== "000") throw new Error(`DART 오류(${body.status})`);
  return body.list;
}

async function fetchDebtFields(
  corpCode: string,
  fiscalYear: number,
  apiKey: string
): Promise<{ fsDiv: "CFS" | "OFS"; shortTermDebt: number | null; longTermDebt: number | null; bondsPayable: number | null; interestExpense: number | null } | null> {
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

      return {
        fsDiv,
        shortTermDebt: findAmount(list, "BS", SHORT_TERM_DEBT_ACCOUNT_IDS),
        longTermDebt: findAmount(list, "BS", LONG_TERM_DEBT_ACCOUNT_IDS),
        bondsPayable: findAmount(list, "BS", BONDS_PAYABLE_ACCOUNT_IDS),
        interestExpense: findAmount(list, "CF", INTEREST_EXPENSE_ACCOUNT_IDS),
      };
    } catch (error) {
      lastError = error;
      if (attempt < CALL_RETRY_COUNT) await sleep(CALL_RETRY_BASE_DELAY_MS * 2 ** attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function main(): Promise<void> {
  const apiKey = process.env.DART_API_KEY;
  if (!apiKey) throw new Error("DART_API_KEY 환경 변수가 없습니다.");

  const startedAt = new Date();

  console.log("재조회 대상 조회 중...");
  const targets: RefillTarget[] = [];
  let from = 0;
  const PAGE = 1000;
  for (;;) {
    const { data, error } = await supabaseAdmin
      .from("dart_debt_structure")
      .select("stock_code, corp_code, fiscal_year, short_term_debt, long_term_debt, bonds_payable")
      .or("short_term_debt.is.null,long_term_debt.is.null,bonds_payable.is.null")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`dart_debt_structure 조회 실패: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const row of data) {
      targets.push({ stockCode: row.stock_code as string, corpCode: row.corp_code as string, fiscalYear: row.fiscal_year as number });
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }
  console.log(`재조회 대상 ${targets.length}건`);

  let refilled = 0;
  let stillNull = 0;
  let noData = 0;
  let errors = 0;
  let completed = 0;

  await runWithConcurrency(targets, CONCURRENCY, async (target) => {
    try {
      const fields = await fetchDebtFields(target.corpCode, target.fiscalYear, apiKey);
      if (!fields) {
        noData++;
        return;
      }

      const { error } = await supabaseAdmin
        .from("dart_debt_structure")
        .update({
          short_term_debt: fields.shortTermDebt,
          long_term_debt: fields.longTermDebt,
          bonds_payable: fields.bondsPayable,
          interest_expense: fields.interestExpense,
        })
        .eq("stock_code", target.stockCode)
        .eq("fiscal_year", target.fiscalYear);
      if (error) throw new Error(`업데이트 실패: ${error.message}`);

      if (fields.shortTermDebt !== null || fields.longTermDebt !== null || fields.bondsPayable !== null) {
        refilled++;
      } else {
        stillNull++;
      }
    } catch (error) {
      errors++;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  ${target.stockCode} FY${target.fiscalYear} 실패: ${message}`);
    } finally {
      completed++;
      if (completed % 100 === 0 || completed === targets.length) {
        console.log(`진행: ${completed}/${targets.length}건 (일부채움 ${refilled}, 여전히null ${stillNull}, 데이터없음 ${noData}, 실패 ${errors})`);
      }
    }
  });

  console.log(
    `리필 완료: 총 ${targets.length}건 중 일부라도 채워짐 ${refilled}건, 여전히 전부 null ${stillNull}건, 원본 데이터 없음 ${noData}건, 실패 ${errors}건(다음 실행에서 재시도됨)`
  );

  const { error: checkpointError } = await supabaseAdmin.from("stock_data_backfill_runs").insert({
    data_source: DATA_SOURCE,
    last_completed_date: null,
    started_at: startedAt.toISOString(),
    finished_at: new Date().toISOString(),
    rows_fetched: refilled,
    error_count: errors,
  });
  if (checkpointError) console.error(`체크포인트 저장 실패: ${checkpointError.message}`);
}

main().catch((error) => {
  console.error("리필 중 오류:", error);
  process.exit(1);
});
