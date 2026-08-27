/**
 * (임시) EPS 잔여 오차 조사용 읽기 전용 스크립트. 삼성전자(005930)의
 * fnlttSinglAcntAll(전체 재무제표) 응답에서 "주당"이 들어간 계정(기본주당순이익 등,
 * 회사가 가중평균유통주식수로 직접 계산해 공시하는 값)이 실제로 존재하는지, 있다면
 * 한국투자증권 표시 EPS(6,564원)와 얼마나 가까운지 확인한다. DB/코드를 건드리지
 * 않는다 — 확인 끝나면 삭제.
 *
 *   tsx --conditions=react-server scripts/verify-valuation-005930.ts
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";

const STOCK_CODE = "005930";
const REPRT_CODE_ANNUAL = "11011";
const BSNS_YEAR = 2025;

interface Item {
  sj_div: string;
  account_nm: string;
  thstrm_amount: string;
  frmtrm_amount: string;
}

async function dumpPerShareAndCounts(fsDiv: "CFS" | "OFS", apiKey: string, corpCode: string): Promise<void> {
  console.log(`\n=== fnlttSinglAcntAll fs_div=${fsDiv}: "주당" 포함 계정 전체 ===`);
  const url =
    `https://opendart.fss.or.kr/api/fnlttSinglAcntAll.json?crtfc_key=${encodeURIComponent(apiKey)}` +
    `&corp_code=${encodeURIComponent(corpCode)}&bsns_year=${BSNS_YEAR}&reprt_code=${REPRT_CODE_ANNUAL}&fs_div=${fsDiv}`;
  const res = await fetch(url);
  const body = await res.json();
  console.log(`status: ${body.status}, message: ${body.message ?? ""}`);
  const list = (body.list ?? []) as Item[];
  const perShare = list.filter((i) => i.account_nm.includes("주당"));
  if (perShare.length === 0) {
    console.log("  (주당 관련 계정 없음)");
  }
  for (const item of perShare) {
    console.log(`  [${item.sj_div}] ${item.account_nm} = 당기:${item.thstrm_amount} / 전기:${item.frmtrm_amount}`);
  }
}

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

  await dumpPerShareAndCounts("CFS", apiKey, corp.corp_code);
  await dumpPerShareAndCounts("OFS", apiKey, corp.corp_code);
}

main().catch((error) => {
  console.error("조사 스크립트 실행 중 오류:", error);
  process.exit(1);
});
