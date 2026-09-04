/**
 * DCF 2단계(WACC)를 정확하게 계산하려면 dart_debt_structure의 long_term_debt(77.8%
 * null)/bonds_payable(93.4% null)이 실제로 "값이 0"이 아니라 DART 계정과목 매칭
 * 실패로 못 채워졌다는 걸 실측으로 확인해야 한다(2026-09-04
 * diagnose-dcf-data-coverage.yml 결과). lib/dartValuationConfig.ts의
 * LONG_TERM_DEBT_ACCOUNT_IDS/BONDS_PAYABLE_ACCOUNT_IDS 후보 목록이 삼성전자/SK
 * 하이닉스/현대차 3사(0단계 최초 진단)로만 확정됐던 게 원인으로 추정된다 —
 * 업종이 다양한 종목까지 커버하지 못했을 가능성이 높다.
 *
 * long_term_debt 또는 bonds_payable이 null인 실제 종목들을 넓게 샘플링해서
 * fnlttSinglAcntAll을 다시 호출하고, 재무상태표(BS)에서 "차입금"/"사채" 키워드가
 * 들어간 계정과목을 전부 덤프한다. 현재 후보 목록에 없는 account_id가 얼마나
 * 자주 등장하는지 빈도를 집계해, 설정을 확장할 근거를 남긴다.
 *
 * DB에는 아무것도 쓰지 않는 읽기 전용 진단.
 *
 * 필요 환경변수: DART_API_KEY, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   tsx --conditions=react-server scripts/diagnose-dart-debt-account-tags.ts
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { LONG_TERM_DEBT_ACCOUNT_IDS, BONDS_PAYABLE_ACCOUNT_IDS, SHORT_TERM_DEBT_ACCOUNT_IDS } from "@/lib/dartValuationConfig";

const DART_BASE_URL = "https://opendart.fss.or.kr/api";
const SAMPLE_SIZE = 40;
const CONCURRENCY = 2;
const CALL_RETRY_COUNT = 3;
const CALL_RETRY_BASE_DELAY_MS = 5000;

interface DartAccountRow {
  rcept_no: string;
  sj_div: string;
  account_id: string;
  account_nm: string;
  fs_div?: string;
  thstrm_amount: string;
}

interface SampleTarget {
  stockCode: string;
  corpCode: string;
  fiscalYear: number;
}

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

async function fetchWithRetry(corpCode: string, fiscalYear: number, apiKey: string): Promise<DartAccountRow[] | null> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= CALL_RETRY_COUNT; attempt++) {
    try {
      let list = await callSingleAcntAll(corpCode, fiscalYear, "CFS", apiKey);
      if (!list) list = await callSingleAcntAll(corpCode, fiscalYear, "OFS", apiKey);
      return list;
    } catch (error) {
      lastError = error;
      if (attempt < CALL_RETRY_COUNT) await sleep(CALL_RETRY_BASE_DELAY_MS * 2 ** attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function pickSample(): Promise<SampleTarget[]> {
  const { data, error } = await supabaseAdmin
    .from("dart_debt_structure")
    .select("stock_code, corp_code, fiscal_year, long_term_debt, bonds_payable")
    .or("long_term_debt.is.null,bonds_payable.is.null")
    .order("fiscal_year", { ascending: false })
    .limit(2000);
  if (error) throw new Error(`dart_debt_structure 조회 실패: ${error.message}`);

  // 종목당 가장 최근 연도 행 하나만 남긴다(같은 종목을 여러 번 호출하지 않기 위해).
  const latestByStock = new Map<string, SampleTarget>();
  for (const row of data ?? []) {
    const code = row.stock_code as string;
    if (latestByStock.has(code)) continue;
    latestByStock.set(code, { stockCode: code, corpCode: row.corp_code as string, fiscalYear: row.fiscal_year as number });
  }

  const all = Array.from(latestByStock.values());
  // 골고루 훑어보려고 일정 간격으로 SAMPLE_SIZE개를 뽑는다(전부 같은 업종에
  // 몰리지 않게).
  const step = Math.max(1, Math.floor(all.length / SAMPLE_SIZE));
  const sample: SampleTarget[] = [];
  for (let i = 0; i < all.length && sample.length < SAMPLE_SIZE; i += step) {
    sample.push(all[i]);
  }
  return sample;
}

async function main(): Promise<void> {
  const apiKey = process.env.DART_API_KEY;
  if (!apiKey) throw new Error("DART_API_KEY 환경 변수가 없습니다.");

  const sample = await pickSample();
  console.log(`샘플 ${sample.length}개 종목 선정(long_term_debt 또는 bonds_payable이 null인 종목 중 균등 추출)`);
  console.log(JSON.stringify(sample.map((s) => `${s.stockCode}(FY${s.fiscalYear})`)));

  // account_id별 등장 빈도(장기차입금/사채 키워드 각각) 집계.
  const longTermDebtTagCounts = new Map<string, { count: number; sampleNm: string }>();
  const bondsPayableTagCounts = new Map<string, { count: number; sampleNm: string }>();
  let completed = 0;
  let errors = 0;

  await runWithConcurrency(sample, CONCURRENCY, async (target) => {
    try {
      const list = await fetchWithRetry(target.corpCode, target.fiscalYear, apiKey);
      if (!list) {
        console.log(`  [${target.stockCode}] FY${target.fiscalYear}: 데이터 없음`);
        return;
      }
      const bsRows = list.filter((r) => r.sj_div === "BS" && /차입금|사채/.test(r.account_nm));
      console.log(`\n--- [${target.stockCode}] FY${target.fiscalYear} BS 차입금/사채 키워드 항목 ---`);
      for (const row of bsRows) {
        const isCurrent = /유동/.test(row.account_nm) && !/비유동/.test(row.account_nm);
        console.log(
          `  account_id=${row.account_id} account_nm=${row.account_nm} amount=${row.thstrm_amount} [현재 후보에 있음: 단기=${SHORT_TERM_DEBT_ACCOUNT_IDS.includes(row.account_id)}, 장기=${LONG_TERM_DEBT_ACCOUNT_IDS.includes(row.account_id)}, 사채=${BONDS_PAYABLE_ACCOUNT_IDS.includes(row.account_id)}]`
        );
        if (/사채/.test(row.account_nm)) {
          const entry = bondsPayableTagCounts.get(row.account_id) ?? { count: 0, sampleNm: row.account_nm };
          entry.count++;
          bondsPayableTagCounts.set(row.account_id, entry);
        } else if (/장기|비유동/.test(row.account_nm) || !isCurrent) {
          const entry = longTermDebtTagCounts.get(row.account_id) ?? { count: 0, sampleNm: row.account_nm };
          entry.count++;
          longTermDebtTagCounts.set(row.account_id, entry);
        }
      }
    } catch (error) {
      errors++;
      console.error(`  [${target.stockCode}] 호출 실패: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      completed++;
      if (completed % 10 === 0 || completed === sample.length) {
        console.log(`\n진행: ${completed}/${sample.length}건 (실패 ${errors})`);
      }
    }
  });

  console.log("\n########## 장기차입금류 account_id 빈도 집계(현재 후보 목록 미포함 위주로 검토) ##########");
  console.log(
    JSON.stringify(
      Array.from(longTermDebtTagCounts.entries())
        .sort((a, b) => b[1].count - a[1].count)
        .map(([id, v]) => ({ account_id: id, count: v.count, sample_nm: v.sampleNm, 현재후보에있음: LONG_TERM_DEBT_ACCOUNT_IDS.includes(id) }))
    )
  );

  console.log("\n########## 사채류 account_id 빈도 집계(현재 후보 목록 미포함 위주로 검토) ##########");
  console.log(
    JSON.stringify(
      Array.from(bondsPayableTagCounts.entries())
        .sort((a, b) => b[1].count - a[1].count)
        .map(([id, v]) => ({ account_id: id, count: v.count, sample_nm: v.sampleNm, 현재후보에있음: BONDS_PAYABLE_ACCOUNT_IDS.includes(id) }))
    )
  );

  console.log("\n=== 진단 종료 ===");
}

main().catch((error) => {
  console.error("진단 스크립트 실행 중 오류:", error);
  process.exit(1);
});
