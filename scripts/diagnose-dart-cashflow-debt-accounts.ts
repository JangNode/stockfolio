/**
 * RIM/DCF 적정주가 계산용 현금흐름표/부채구조 배치를 설계하기 전에, DART 다중회사
 * 조회 endpoint(fnlttMultiAcnt)가 현금흐름표 세부항목(영업/투자/재무활동현금흐름,
 * capex)과 부채구조 세부항목(단기/장기차입금, 사채, 이자비용)을 실제로 포함하는지
 * 확인한다. 포함하지 않으면(다중회사 endpoint는 보통 "주요계정"만 제공한다고
 * 알려져 있음 — 이 세션에선 실응답 미검증) 단일회사 endpoint(fnlttSinglAcntAll)를
 * 종목별로 개별 호출하는 기존 scripts/backfill-stock-annual-fundamentals.ts와
 * 동일한 방식으로 확정한다.
 *
 * 겸사겸사 fnlttSinglAcntAll 응답에서 현금흐름표(CF)/재무상태표 부채 관련/손익계산서
 * 이자비용 관련 계정과목(account_id, account_nm)을 전부 덤프해서, 실제 배치가 어떤
 * account_id로 capex/이자비용/단기·장기차입금/사채를 매칭해야 하는지 판단 근거를
 * 남긴다. 계정과목명이 회사마다 다를 수 있어 억지로 유사 항목을 끌어다 채우지
 * 않기로 했으므로(사용자 요청), 매칭 실패를 미리 걸러내는 게 이 진단의 목적이다.
 *
 * DB에는 아무것도 쓰지 않는 읽기 전용 진단 — 계정과목 매핑이 확정되면 정리 PR에서
 * 스크립트/워크플로와 함께 삭제한다.
 *
 * 필요 환경변수: DART_API_KEY, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   tsx --conditions=react-server scripts/diagnose-dart-cashflow-debt-accounts.ts
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";

const DART_BASE_URL = "https://opendart.fss.or.kr/api";
// 삼성전자(연결대상 자회사 많음), SK하이닉스, 현대차 — 업종이 달라 계정과목 표기
// 편차를 넓게 확인하려는 목적으로 골랐다.
const SAMPLE_STOCK_CODES = ["005930", "000660", "005380"];

interface DartAccountRow {
  rcept_no: string;
  corp_code?: string;
  sj_div: string;
  sj_nm?: string;
  account_id: string;
  account_nm: string;
  fs_div?: string;
  fs_nm?: string;
  thstrm_amount: string;
}

async function getCorpCodes(stockCodes: string[]): Promise<Map<string, string>> {
  const { data, error } = await supabaseAdmin
    .from("dart_corp_codes")
    .select("stock_code, corp_code")
    .in("stock_code", stockCodes);
  if (error) throw new Error(`corp_code 조회 실패: ${error.message}`);
  const map = new Map<string, string>();
  for (const row of data ?? []) {
    if (row.stock_code) map.set(row.stock_code, row.corp_code);
  }
  return map;
}

async function callMultiAcnt(corpCodes: string[], apiKey: string, bsnsYear: number): Promise<void> {
  const url = new URL(`${DART_BASE_URL}/fnlttMultiAcnt.json`);
  url.searchParams.set("crtfc_key", apiKey);
  url.searchParams.set("corp_code", corpCodes.join(","));
  url.searchParams.set("bsns_year", String(bsnsYear));
  url.searchParams.set("reprt_code", "11011");

  console.log(`\n=== fnlttMultiAcnt 호출: corp_code=${corpCodes.join(",")} bsns_year=${bsnsYear} ===`);
  const res = await fetch(url);
  if (!res.ok) {
    console.log(`HTTP ${res.status}`);
    return;
  }
  const body = (await res.json()) as { status: string; message?: string; list?: DartAccountRow[] };
  console.log(`status=${body.status} message=${body.message ?? ""}`);
  if (!body.list || body.list.length === 0) {
    console.log("list 없음 — 다중회사 endpoint에서 데이터를 받지 못함");
    return;
  }

  console.log(`총 ${body.list.length}개 행`);
  const sjDivs = new Set(body.list.map((r) => r.sj_div));
  console.log(`sj_div 종류: ${Array.from(sjDivs).join(", ")}`);
  console.log(`현금흐름표(CF) 항목 포함 여부: ${sjDivs.has("CF")}`);

  const debtLike = body.list.filter((r) => /차입금|사채|이자비용/.test(r.account_nm));
  console.log(`부채/이자 키워드("차입금"/"사채"/"이자비용") 매칭 항목 수: ${debtLike.length}`);
  for (const row of debtLike.slice(0, 20)) {
    console.log(
      `  [${row.corp_code}] sj_div=${row.sj_div} account_id=${row.account_id} account_nm=${row.account_nm} amount=${row.thstrm_amount}`
    );
  }

  console.log("--- 전체 계정과목 목록(중복 제거, sj_div:account_id:account_nm 기준) ---");
  const seen = new Set<string>();
  for (const row of body.list) {
    const key = `${row.sj_div}:${row.account_id}:${row.account_nm}`;
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(`  sj_div=${row.sj_div} account_id=${row.account_id} account_nm=${row.account_nm}`);
  }
}

async function callSingleAcntAll(
  stockCode: string,
  corpCode: string,
  apiKey: string,
  bsnsYear: number,
  fsDiv: "CFS" | "OFS"
): Promise<DartAccountRow[] | null> {
  const url = new URL(`${DART_BASE_URL}/fnlttSinglAcntAll.json`);
  url.searchParams.set("crtfc_key", apiKey);
  url.searchParams.set("corp_code", corpCode);
  url.searchParams.set("bsns_year", String(bsnsYear));
  url.searchParams.set("reprt_code", "11011");
  url.searchParams.set("fs_div", fsDiv);

  const res = await fetch(url);
  if (!res.ok) {
    console.log(`  [${stockCode}] ${fsDiv} ${bsnsYear}: HTTP ${res.status}`);
    return null;
  }
  const body = (await res.json()) as { status: string; message?: string; list?: DartAccountRow[] };
  if (body.status === "013" || !body.list || body.list.length === 0) {
    console.log(`  [${stockCode}] ${fsDiv} ${bsnsYear}: 데이터 없음(status=${body.status})`);
    return null;
  }
  if (body.status !== "000") {
    console.log(`  [${stockCode}] ${fsDiv} ${bsnsYear}: 오류(status=${body.status}, message=${body.message})`);
    return null;
  }
  return body.list;
}

function dumpRelevant(stockCode: string, fsDiv: string, list: DartAccountRow[]): void {
  console.log(`\n--- [${stockCode}] fs_div=${fsDiv} rcept_no=${list[0]?.rcept_no} 현금흐름표(CF) 전체 항목 ---`);
  for (const row of list.filter((r) => r.sj_div === "CF")) {
    console.log(`  account_id=${row.account_id} account_nm=${row.account_nm} amount=${row.thstrm_amount}`);
  }
  console.log(`--- [${stockCode}] fs_div=${fsDiv} 재무상태표(BS) 중 "차입금"/"사채" 키워드 항목 ---`);
  for (const row of list.filter((r) => r.sj_div === "BS" && /차입금|사채/.test(r.account_nm))) {
    console.log(`  account_id=${row.account_id} account_nm=${row.account_nm} amount=${row.thstrm_amount}`);
  }
  console.log(`--- [${stockCode}] fs_div=${fsDiv} 손익계산서(IS) 중 "이자" 키워드 항목 ---`);
  for (const row of list.filter((r) => r.sj_div === "IS" && /이자/.test(r.account_nm))) {
    console.log(`  account_id=${row.account_id} account_nm=${row.account_nm} amount=${row.thstrm_amount}`);
  }
}

async function main(): Promise<void> {
  const apiKey = process.env.DART_API_KEY;
  if (!apiKey) throw new Error("DART_API_KEY 환경 변수가 없습니다.");

  const bsnsYear = new Date().getFullYear() - 1;

  const corpCodeMap = await getCorpCodes(SAMPLE_STOCK_CODES);
  console.log(
    `corp_code 매핑: ${Array.from(corpCodeMap.entries())
      .map(([s, c]) => `${s}→${c}`)
      .join(", ")}`
  );
  const corpCodes = Array.from(corpCodeMap.values());
  if (corpCodes.length === 0) {
    throw new Error("corp_code 매핑을 찾지 못했습니다. sync-dart-corp-codes가 먼저 실행됐는지 확인하세요.");
  }

  console.log("\n########## 1) 다중회사 조회(fnlttMultiAcnt) 확인 ##########");
  await callMultiAcnt(corpCodes, apiKey, bsnsYear);

  console.log("\n########## 2) 단일회사 전체 재무제표(fnlttSinglAcntAll) 확인 ##########");
  for (const [stockCode, corpCode] of corpCodeMap.entries()) {
    let list = await callSingleAcntAll(stockCode, corpCode, apiKey, bsnsYear, "CFS");
    let fsDiv = "CFS";
    if (!list) {
      list = await callSingleAcntAll(stockCode, corpCode, apiKey, bsnsYear, "OFS");
      fsDiv = "OFS";
    }
    if (!list) {
      console.log(`  [${stockCode}] CFS/OFS 둘 다 데이터 없음`);
      continue;
    }
    dumpRelevant(stockCode, fsDiv, list);
  }

  console.log("\n=== 진단 종료 ===");
}

main().catch((error) => {
  console.error("진단 스크립트 실행 중 오류:", error);
  process.exit(1);
});
