/**
 * (임시) 2026-09-08 dart_fundamentals 백필 재실행에서 6,564건 중 6,553건이
 * "데이터없음(013)"으로 나온 원인을 확인한다. 가설: 이 스크립트가 fs_div=CFS
 * (연결재무제표)만 조회하는데, 신규 후보 종목 다수가 자회사가 없어 연결재무제표를
 * 아예 작성하지 않고 별도재무제표(OFS)만 제출할 수 있다 — backfill-dart-cashflow-debt.ts는
 * 이미 CFS→OFS 폴백이 있다.
 *
 * 읽기 전용, DART API만 호출하고 아무것도 쓰지 않는다. 확인 후 즉시 삭제 예정.
 * tsx --conditions=react-server scripts/diagnose-dart-cfs-ofs-hypothesis.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { discoverCandidateStockCodes } from "@/lib/stockDailyPricesStorage";
import { STOCK_DATA_CANDIDATE_MARKET_CAP_EOK } from "@/lib/stockDataConfig";

const DART_BASE_URL = "https://opendart.fss.or.kr/api";
const FISCAL_YEAR_START = 2009;
const SAMPLE_SIZE = 8;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface DartAccountRow {
  rcept_no: string;
  sj_div: string;
  account_id: string;
  thstrm_amount: string;
}

async function callSingleAcntAll(
  corpCode: string,
  fiscalYear: number,
  fsDiv: "CFS" | "OFS",
  apiKey: string
): Promise<{ status: string; list?: DartAccountRow[] }> {
  const url = new URL(`${DART_BASE_URL}/fnlttSinglAcntAll.json`);
  url.searchParams.set("crtfc_key", apiKey);
  url.searchParams.set("corp_code", corpCode);
  url.searchParams.set("bsns_year", String(fiscalYear));
  url.searchParams.set("reprt_code", "11011");
  url.searchParams.set("fs_div", fsDiv);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as { status: string; list?: DartAccountRow[] };
}

async function fetchCompanyInfo(corpCode: string, apiKey: string): Promise<Record<string, unknown> | null> {
  const url = new URL(`${DART_BASE_URL}/company.json`);
  url.searchParams.set("crtfc_key", apiKey);
  url.searchParams.set("corp_code", corpCode);
  const res = await fetch(url);
  if (!res.ok) return null;
  return (await res.json()) as Record<string, unknown>;
}

async function main(): Promise<void> {
  const apiKey = process.env.DART_API_KEY;
  if (!apiKey) throw new Error("DART_API_KEY 환경 변수가 없습니다.");

  let dartCallCount = 0;

  console.log("########## 1. 후보종목/기존 데이터 재구성 (직전 백필 실행과 동일 기준) ##########");
  const currentYear = new Date().getUTCFullYear();
  const priceYears = Array.from({ length: currentYear - 2011 + 1 }, (_, i) => 2011 + i);
  const candidates = await discoverCandidateStockCodes(priceYears, STOCK_DATA_CANDIDATE_MARKET_CAP_EOK);
  console.log(`  후보종목 ${candidates.length}개`);

  const { data: corpRows, error: corpError } = await supabaseAdmin
    .from("dart_corp_codes")
    .select("stock_code, corp_code, corp_name")
    .in("stock_code", candidates);
  if (corpError) throw new Error(corpError.message);
  const corpMap = new Map<string, { corp_code: string; corp_name: string }>();
  for (const row of corpRows ?? []) {
    if (row.stock_code) corpMap.set(row.stock_code, { corp_code: row.corp_code, corp_name: row.corp_name });
  }

  const { data: fundRows, error: fundError } = await supabaseAdmin.from("stock_annual_fundamentals").select("stock_code");
  if (fundError) throw new Error(fundError.message);
  const stocksWithData = new Set((fundRows ?? []).map((r) => r.stock_code));

  const zeroDataCandidates = candidates.filter((c) => corpMap.has(c) && !stocksWithData.has(c));
  console.log(`  corp_code 매핑 있고 기존 데이터가 하나도 없는 종목: ${zeroDataCandidates.length}개`);

  // 재현성을 위해 정렬 후 균등 간격으로 표본 추출(맨 앞 몇 개만 고르면 특정 산업군에 쏠릴 수 있음).
  const sorted = [...zeroDataCandidates].sort();
  const step = Math.max(1, Math.floor(sorted.length / SAMPLE_SIZE));
  const sample = Array.from({ length: SAMPLE_SIZE }, (_, i) => sorted[Math.min(i * step, sorted.length - 1)]);
  console.log(`  표본 ${sample.length}개: ${sample.join(", ")}`);

  const fiscalYears = Array.from({ length: currentYear - FISCAL_YEAR_START }, (_, i) => FISCAL_YEAR_START + i);

  console.log("\n########## 2. 표본별 CFS/OFS 전체 연도 조회 ##########");
  let stocksWithAnyOfsData = 0;
  let stocksWithNoDataEitherWay = 0;

  for (const stockCode of sample) {
    const corp = corpMap.get(stockCode);
    if (!corp) continue;
    console.log(`\n  --- ${stockCode} (${corp.corp_name}, corp_code=${corp.corp_code}) ---`);

    const cfsYears: number[] = [];
    const ofsOnlyYears: number[] = [];
    const neitherYears: number[] = [];

    for (const fiscalYear of fiscalYears) {
      let cfsBody: { status: string; list?: DartAccountRow[] } | null = null;
      try {
        cfsBody = await callSingleAcntAll(corp.corp_code, fiscalYear, "CFS", apiKey);
        dartCallCount++;
      } catch (error) {
        console.log(`    FY${fiscalYear} CFS 호출 실패: ${error instanceof Error ? error.message : String(error)}`);
      }
      await sleep(300);

      const cfsHasData = cfsBody?.status === "000" && (cfsBody.list?.length ?? 0) > 0;
      if (cfsHasData) {
        cfsYears.push(fiscalYear);
        continue;
      }

      let ofsBody: { status: string; list?: DartAccountRow[] } | null = null;
      try {
        ofsBody = await callSingleAcntAll(corp.corp_code, fiscalYear, "OFS", apiKey);
        dartCallCount++;
      } catch (error) {
        console.log(`    FY${fiscalYear} OFS 호출 실패: ${error instanceof Error ? error.message : String(error)}`);
      }
      await sleep(300);

      const ofsHasData = ofsBody?.status === "000" && (ofsBody.list?.length ?? 0) > 0;
      if (ofsHasData) {
        ofsOnlyYears.push(fiscalYear);
      } else {
        neitherYears.push(fiscalYear);
      }
    }

    console.log(`    CFS로 데이터 있는 연도: ${cfsYears.join(",") || "없음"}`);
    console.log(`    CFS엔 없고 OFS엔 있는 연도: ${ofsOnlyYears.join(",") || "없음"}`);
    console.log(`    CFS/OFS 둘 다 없는 연도: ${neitherYears.join(",") || "없음"}`);

    if (ofsOnlyYears.length > 0) stocksWithAnyOfsData++;
    if (cfsYears.length === 0 && ofsOnlyYears.length === 0) {
      stocksWithNoDataEitherWay++;
      const info = await fetchCompanyInfo(corp.corp_code, apiKey);
      dartCallCount++;
      console.log(`    company.json: est_dt=${info?.est_dt ?? "?"} stock_name=${info?.stock_name ?? "?"} corp_cls=${info?.corp_cls ?? "?"}`);
    }
  }

  console.log("\n########## 3. 요약 ##########");
  console.log(`  표본 ${sample.length}개 중 CFS엔 없지만 OFS엔 있는 연도가 하나라도 있는 종목: ${stocksWithAnyOfsData}개`);
  console.log(`  표본 ${sample.length}개 중 CFS/OFS 둘 다 전 기간 데이터 없는 종목: ${stocksWithNoDataEitherWay}개`);
  console.log(`  이번 진단에서 사용한 DART 호출 수: ${dartCallCount}건`);
  console.log("\n=== 진단 종료 ===");
}

main().catch((error) => {
  console.error("진단 중 오류:", error);
  process.exit(1);
});
