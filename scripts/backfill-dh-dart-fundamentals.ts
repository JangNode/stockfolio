/**
 * DH전략(대형 배당·가치주) 백테스트용 과거 PER/PBR 재구성의 2단계 — 후보종목(백필
 * 기간 중 단 하루라도 시가총액 1조원을 넘은 적 있는 종목)을 dh_daily_market_data에서
 * 직접 뽑고, 각 종목×연도에 대해 DART fnlttSinglAcntAll(단일회사 전체 재무제표)을
 * 호출해 지배기업 소유주지분 당기순이익/자본총계를 dh_annual_fundamentals에 채운다.
 * "오늘 기준 대형주 리스트"가 아니라 실제 과거 시가총액으로 후보를 뽑기 때문에
 * 생존편향이 없다(과거엔 컸는데 지금 작아진 회사도 포함, 반대도 마찬가지).
 *
 * 연도 범위: 백테스트 기간 시작(2016년, 5년 배당 lookback 포함 2011년)의 point-in-time
 * 조회가 항상 유효한 재무를 찾을 수 있도록 FY2009부터(2010년 3월경 공시, 2011년 초
 * 조회 시점에 이미 최신 공개 재무) 최신 사업연도까지를 대상으로 한다.
 *
 * dh_annual_fundamentals는 (stock_code, fiscal_year) 기본키라 이미 있는 조합은
 * upsert로 건너뛰지 않고 다시 채워도 안전하다(idempotent) — 그래서 별도 날짜 체크포인트
 * 대신, 이미 있는 (stock_code, fiscal_year) 조합은 호출 전에 걸러내는 방식으로 재개한다.
 *
 * server-only로 막힌 lib/supabaseAdmin.ts를 순수 Node 스크립트에서도 재사용하려면
 * "react-server" 조건으로 실행해야 한다:
 *   tsx --conditions=react-server scripts/backfill-dh-dart-fundamentals.ts
 *
 * 필요 환경변수: DART_API_KEY, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";

const DART_BASE_URL = "https://opendart.fss.or.kr/api";
const DATA_SOURCE = "dart_fundamentals" as const;
const MIN_MARKET_CAP_EOK_CANDIDATE = 10_000; // 1조원
const FISCAL_YEAR_START = 2009;
const CONCURRENCY = 8;
const CALL_RETRY_COUNT = 2;
const CALL_RETRY_DELAY_MS = 1500;

const NET_INCOME_ACCOUNT_ID = "ifrs-full_ProfitLossAttributableToOwnersOfParent";
const EQUITY_ACCOUNT_ID = "ifrs-full_EquityAttributableToOwnersOfParent";

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

/** 백필 기간 중 단 하루라도 시가총액 1조원을 넘은 적 있는 종목을 뽑는다. "오늘 기준"이
 * 아니라 실측 과거 시가총액을 쓰므로 생존편향이 없다. */
async function discoverCandidates(): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from("dh_daily_market_data")
    .select("stock_code")
    .gte("market_cap_eok", MIN_MARKET_CAP_EOK_CANDIDATE);
  if (error) throw new Error(`후보종목 발굴 실패: ${error.message}`);
  return Array.from(new Set((data ?? []).map((r) => r.stock_code)));
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

async function getExistingPairs(): Promise<Set<string>> {
  const existing = new Set<string>();
  let from = 0;
  const PAGE = 1000;
  for (;;) {
    const { data, error } = await supabaseAdmin
      .from("dh_annual_fundamentals")
      .select("stock_code, fiscal_year")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`기존 재무 데이터 조회 실패: ${error.message}`);
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

async function fetchFundamentals(
  corpCode: string,
  fiscalYear: number,
  apiKey: string
): Promise<{ rceptNo: string; rceptDate: string; netIncomeParent: number | null; equityParent: number | null } | null> {
  const url = new URL(`${DART_BASE_URL}/fnlttSinglAcntAll.json`);
  url.searchParams.set("crtfc_key", apiKey);
  url.searchParams.set("corp_code", corpCode);
  url.searchParams.set("bsns_year", String(fiscalYear));
  url.searchParams.set("reprt_code", "11011"); // 사업보고서
  url.searchParams.set("fs_div", "CFS"); // 연결재무제표

  let lastError: unknown;
  for (let attempt = 0; attempt <= CALL_RETRY_COUNT; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { status: string; list?: DartAccountRow[] };

      // status "013"은 "조회된 데이터가 없습니다" — 그 연도에 사업보고서가 없는 경우
      // (상장 전 등)라 정상적인 "없음"으로 취급하고 에러로 올리지 않는다.
      if (body.status === "013" || !body.list || body.list.length === 0) return null;
      if (body.status !== "000") throw new Error(`DART 오류(${body.status})`);

      const rceptNo = body.list[0].rcept_no;
      const netIncomeRow = body.list.find((r) => r.account_id === NET_INCOME_ACCOUNT_ID);
      const equityRow = body.list.find((r) => r.account_id === EQUITY_ACCOUNT_ID);

      // 접속사·지주사가 아니거나 비지배지분이 없는 회사는 "지배기업 소유주지분"이
      // 별도 항목으로 안 나오고 전체 당기순이익/자본총계 항목만 있을 수 있다 — 이
      // 경우 전체 값을 그대로 쓴다(비지배지분이 없으니 전체=지배지분).
      const fallbackNetIncome = body.list.find(
        (r) => r.sj_div === "IS" && r.account_id === "ifrs-full_ProfitLoss"
      );
      const fallbackEquity = body.list.find((r) => r.sj_div === "BS" && r.account_id === "ifrs-full_Equity");

      const netIncomeSource = netIncomeRow ?? fallbackNetIncome;
      const equitySource = equityRow ?? fallbackEquity;

      return {
        rceptNo,
        rceptDate: `${rceptNo.slice(0, 4)}-${rceptNo.slice(4, 6)}-${rceptNo.slice(6, 8)}`,
        netIncomeParent: netIncomeSource ? Number(netIncomeSource.thstrm_amount) : null,
        equityParent: equitySource ? Number(equitySource.thstrm_amount) : null,
      };
    } catch (error) {
      lastError = error;
      if (attempt < CALL_RETRY_COUNT) await sleep(CALL_RETRY_DELAY_MS);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function main(): Promise<void> {
  const apiKey = process.env.DART_API_KEY;
  if (!apiKey) throw new Error("DART_API_KEY 환경 변수가 없습니다.");

  const startedAt = new Date();
  const currentYear = new Date().getFullYear();
  const fiscalYears = Array.from(
    { length: currentYear - FISCAL_YEAR_START },
    (_, i) => FISCAL_YEAR_START + i
  ); // 최신 연도는 아직 사업보고서가 안 나왔을 수 있어 제외(currentYear 미포함)

  console.log("후보종목 발굴 중...");
  const candidates = await discoverCandidates();
  console.log(`후보종목 ${candidates.length}개 (시가총액 1조원 이상 이력 있는 종목)`);

  const corpCodeMap = await getCorpCodeMap(candidates);
  console.log(`corp_code 매핑 확인된 종목 ${corpCodeMap.size}개 (매핑 안 된 ${candidates.length - corpCodeMap.size}개는 건너뜀)`);

  const existingPairs = await getExistingPairs();

  const targets: { stockCode: string; corpCode: string; fiscalYear: number }[] = [];
  for (const stockCode of candidates) {
    const corpCode = corpCodeMap.get(stockCode);
    if (!corpCode) continue;
    for (const fiscalYear of fiscalYears) {
      if (!existingPairs.has(`${stockCode}:${fiscalYear}`)) {
        targets.push({ stockCode, corpCode, fiscalYear });
      }
    }
  }

  console.log(`처리 대상 ${targets.length}건 (이미 있는 조합은 건너뜀)`);
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
      const result = await fetchFundamentals(target.corpCode, target.fiscalYear, apiKey);
      if (result) {
        const { error } = await supabaseAdmin.from("dh_annual_fundamentals").upsert({
          stock_code: target.stockCode,
          corp_code: target.corpCode,
          fiscal_year: target.fiscalYear,
          rcept_no: result.rceptNo,
          rcept_date: result.rceptDate,
          net_income_parent: result.netIncomeParent,
          equity_parent: result.equityParent,
        });
        if (error) throw new Error(error.message);
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

  const { error: checkpointError } = await supabaseAdmin.from("dh_backfill_runs").insert({
    data_source: DATA_SOURCE,
    last_completed_date: null,
    started_at: startedAt.toISOString(),
    finished_at: new Date().toISOString(),
    rows_fetched: fetched,
    error_count: errorCount,
  });
  if (checkpointError) console.error(`체크포인트 저장 실패: ${checkpointError.message}`);

  console.log(
    `DART 재무 백필 완료: 채움 ${fetched}건, 데이터없음 ${skippedNoData}건, 실패 ${errorCount}건 (실패분은 다음 실행에서 재시도됨)`
  );
}

main().catch((error) => {
  console.error("백필 중 오류:", error);
  process.exit(1);
});
