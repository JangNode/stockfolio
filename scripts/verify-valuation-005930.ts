/**
 * (임시) DH전략 백테스트용 과거 PER/PBR 재구성 가능성 확인 — DART fnlttSinglAcntAll 진단.
 * 005930 FY2022 사업보고서(연결)를 받아 rcept_no 존재/형식과 "지배기업 소유주지분"
 * 당기순이익/자본총계 계정과목 존재 여부를 raw로 확인한다. 확인 후 삭제 예정.
 *
 *   tsx --conditions=react-server scripts/verify-valuation-005930.ts
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";

const DART_BASE_URL = "https://opendart.fss.or.kr/api";

async function main(): Promise<void> {
  const apiKey = process.env.DART_API_KEY;
  if (!apiKey) throw new Error("DART_API_KEY 환경 변수가 없습니다.");

  const { data, error } = await supabaseAdmin
    .from("dart_corp_codes")
    .select("corp_code, corp_name, stock_code")
    .eq("stock_code", "005930")
    .maybeSingle();
  if (error) throw new Error(`corp_code 조회 실패: ${error.message}`);
  if (!data) throw new Error("005930의 corp_code를 dart_corp_codes에서 찾을 수 없습니다.");

  console.log("corp_code 매핑:", JSON.stringify(data));

  const url = new URL(`${DART_BASE_URL}/fnlttSinglAcntAll.json`);
  url.searchParams.set("crtfc_key", apiKey);
  url.searchParams.set("corp_code", data.corp_code);
  url.searchParams.set("bsns_year", "2022");
  url.searchParams.set("reprt_code", "11011"); // 사업보고서
  url.searchParams.set("fs_div", "CFS"); // 연결재무제표

  const res = await fetch(url);
  const body = await res.json();

  console.log(`\nHTTP 상태: ${res.status}`);
  console.log(`DART status/message: ${body.status} / ${body.message}`);
  console.log(`output 건수: ${Array.isArray(body.list) ? body.list.length : "N/A"}`);

  if (!Array.isArray(body.list)) {
    console.log("\n전체 응답:", JSON.stringify(body, null, 2));
    return;
  }

  const first = body.list[0];
  console.log("\n=== 첫 행 전체(필드 구조 확인용) ===");
  console.log(JSON.stringify(first, null, 2));

  const rceptNos = new Set(body.list.map((row: { rcept_no?: string }) => row.rcept_no));
  console.log("\n=== rcept_no 종류(전체 행에서 유니크) ===");
  console.log(JSON.stringify(Array.from(rceptNos)));

  console.log("\n=== '당기순이익' 또는 '자본총계' 포함 계정과목 전체 ===");
  for (const row of body.list as {
    account_nm?: string;
    sj_div?: string;
    sj_nm?: string;
    thstrm_amount?: string;
    fs_div?: string;
    fs_nm?: string;
  }[]) {
    if (row.account_nm?.includes("당기순이익") || row.account_nm?.includes("자본총계")) {
      console.log(JSON.stringify(row));
    }
  }
}

main().catch((error) => {
  console.error("확인 중 오류:", error);
  process.exit(1);
});
