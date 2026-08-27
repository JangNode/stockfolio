/**
 * (임시) 상장주식수/지배주주순이익 매칭 오류 진단용 읽기 전용 스크립트. 삼성전자
 * (005930) 하나를 예시로 DART stockTotqySttus(주식의 총수 현황)와
 * fnlttSinglAcntAll(전체 재무제표, CFS/OFS) 원본 응답을 그대로 덤프한다 —
 * lib/dart.ts의 행 매칭 로직(se/account_nm 느슨한 매칭)이 실제 응답과 왜 어긋나는지
 * 확인하는 용도. DB/코드를 건드리지 않는다 — 확인 끝나면 삭제.
 *
 *   tsx --conditions=react-server scripts/verify-valuation-005930.ts
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";

const STOCK_CODE = "005930";
const REPRT_CODE_ANNUAL = "11011";
const BSNS_YEAR = 2025;

async function main(): Promise<void> {
  const apiKey = process.env.DART_API_KEY;
  if (!apiKey) throw new Error("DART_API_KEY 없음");

  const { data: corp } = await supabaseAdmin
    .from("dart_corp_codes")
    .select("corp_code, corp_name")
    .eq("stock_code", STOCK_CODE)
    .maybeSingle();
  console.log(`=== DART corp_code 조회 (${STOCK_CODE}) ===`);
  console.log(corp);
  if (!corp) return;

  console.log(`\n=== DART stockTotqySttus RAW 응답 (corp_code=${corp.corp_code}, bsns_year=${BSNS_YEAR}) ===`);
  const stockUrl =
    `https://opendart.fss.or.kr/api/stockTotqySttus.json?crtfc_key=${encodeURIComponent(apiKey)}` +
    `&corp_code=${encodeURIComponent(corp.corp_code)}&bsns_year=${BSNS_YEAR}&reprt_code=${REPRT_CODE_ANNUAL}`;
  const stockRes = await fetch(stockUrl);
  const stockBody = await stockRes.json();
  console.log(`status: ${stockBody.status}, message: ${stockBody.message ?? ""}`);
  console.log(JSON.stringify(stockBody.list ?? [], null, 2));

  for (const fsDiv of ["CFS", "OFS"] as const) {
    console.log(
      `\n=== DART fnlttSinglAcntAll RAW 응답 (corp_code=${corp.corp_code}, bsns_year=${BSNS_YEAR}, fs_div=${fsDiv}) — 당기순이익/지배 관련 계정만 필터 ===`
    );
    const fsUrl =
      `https://opendart.fss.or.kr/api/fnlttSinglAcntAll.json?crtfc_key=${encodeURIComponent(apiKey)}` +
      `&corp_code=${encodeURIComponent(corp.corp_code)}&bsns_year=${BSNS_YEAR}&reprt_code=${REPRT_CODE_ANNUAL}&fs_div=${fsDiv}`;
    const fsRes = await fetch(fsUrl);
    const fsBody = await fsRes.json();
    console.log(`status: ${fsBody.status}, message: ${fsBody.message ?? ""}, 전체 항목 수: ${(fsBody.list ?? []).length}`);
    const list = (fsBody.list ?? []) as Array<{
      sj_div: string;
      account_nm: string;
      thstrm_amount: string;
    }>;
    const relevant = list.filter(
      (i) => i.account_nm.includes("순이익") || i.account_nm.includes("지배") || i.account_nm.includes("비지배")
    );
    for (const item of relevant) {
      console.log(`  [${item.sj_div}] ${item.account_nm} = ${item.thstrm_amount}`);
    }
  }
}

main().catch((error) => {
  console.error("진단 스크립트 실행 중 오류:", error);
  process.exit(1);
});
