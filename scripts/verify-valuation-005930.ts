/**
 * (임시) 가치평가지표(PER/PBR) 오차 진단용 읽기 전용 스크립트. 삼성전자(005930)
 * 하나를 예시로 (1) 지금 캐싱된 EPS/BPS 계산 재료 원본값, (2) DART가 실제로
 * fnlttMultiAcnt(다중회사 주요계정)로 내려주는 원본 항목 전체(계정명/fs_div/
 * sj_div/금액)를 그대로 출력한다. DB/코드를 건드리지 않는다 — 확인 끝나면 삭제.
 *
 *   tsx --conditions=react-server scripts/verify-valuation-005930.ts
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getStockPrice } from "@/lib/kis";

const STOCK_CODE = "005930";
const REPRT_CODE_ANNUAL = "11011";

async function main(): Promise<void> {
  console.log(`=== ${STOCK_CODE} 캐싱된 dart_financial_statement_years 원본값 ===`);
  const { data: rows, error } = await supabaseAdmin
    .from("dart_financial_statement_years")
    .select("*")
    .eq("stock_code", STOCK_CODE)
    .order("year", { ascending: true });

  if (error) throw new Error(`조회 실패: ${error.message}`);
  console.log(JSON.stringify(rows, null, 2));

  const latest = (rows ?? [])[((rows ?? []).length || 1) - 1];
  if (!latest) {
    console.log("캐싱된 행이 없습니다.");
    return;
  }

  console.log("\n=== 현재 KIS 시세 및 계산된 PER/PBR ===");
  const price = await getStockPrice(STOCK_CODE);
  console.log(`현재가: ${price.currentPrice}`);
  console.log(`EPS(캐싱): ${latest.eps}, BPS(캐싱): ${latest.bps}`);
  console.log(`PER = 현재가/EPS = ${latest.eps ? price.currentPrice / latest.eps : null}`);
  console.log(`PBR = 현재가/BPS = ${latest.bps ? price.currentPrice / latest.bps : null}`);

  console.log(`\n=== DART corp_code 조회 (${STOCK_CODE}) ===`);
  const { data: corp } = await supabaseAdmin
    .from("dart_corp_codes")
    .select("corp_code, corp_name")
    .eq("stock_code", STOCK_CODE)
    .maybeSingle();
  console.log(corp);
  if (!corp) return;

  const apiKey = process.env.DART_API_KEY;
  if (!apiKey) {
    console.log("DART_API_KEY 없음 — 원본 fnlttMultiAcnt 응답 조회는 건너뜁니다.");
    return;
  }

  const bsnsYear = latest.year as number;
  console.log(`\n=== DART fnlttMultiAcnt RAW 응답 (corp_code=${corp.corp_code}, bsns_year=${bsnsYear}, reprt_code=${REPRT_CODE_ANNUAL}) ===`);
  const url =
    `https://opendart.fss.or.kr/api/fnlttMultiAcnt.json?crtfc_key=${encodeURIComponent(apiKey)}` +
    `&corp_code=${encodeURIComponent(corp.corp_code)}&bsns_year=${bsnsYear}&reprt_code=${REPRT_CODE_ANNUAL}`;
  const res = await fetch(url);
  const body = await res.json();
  console.log(`status: ${body.status}, message: ${body.message ?? ""}`);
  const list = (body.list ?? []) as Array<{
    account_nm: string;
    fs_div: string;
    sj_div: string;
    thstrm_amount: string;
  }>;
  for (const item of list) {
    console.log(`  [${item.fs_div}/${item.sj_div}] ${item.account_nm} = ${item.thstrm_amount}`);
  }
}

main().catch((error) => {
  console.error("진단 스크립트 실행 중 오류:", error);
  process.exit(1);
});
