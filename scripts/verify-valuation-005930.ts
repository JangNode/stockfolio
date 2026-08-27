/**
 * (임시) DH전략 백테스트용 과거 PER/PBR 재구성 — 005930, 2023-03-15 기준 실제 계산.
 * KRX stk_bydd_trd(2023-03-15, 종가/상장주식수)와 DART fnlttSinglAcntAll(FY2022,
 * 지배기업 소유주지분 당기순이익/자본총계, rcept_no 2023-03-07 — 테스트일보다 이전이라
 * 미래 데이터 누수 없음)을 조합해 그날 시점 PER/PBR을 계산하고 값이 상식적인지 확인한다.
 * 확인 후 삭제 예정.
 *
 *   tsx --conditions=react-server scripts/verify-valuation-005930.ts
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";

const DART_BASE_URL = "https://opendart.fss.or.kr/api";
const KRX_BASE_URL = "https://data-dbg.krx.co.kr/svc/apis/sto/stk_bydd_trd";

async function main(): Promise<void> {
  const dartKey = process.env.DART_API_KEY;
  const krxKey = process.env.KRX_API_KEY;
  if (!dartKey) throw new Error("DART_API_KEY 환경 변수가 없습니다.");
  if (!krxKey) throw new Error("KRX_API_KEY 환경 변수가 없습니다.");

  // 1) KRX에서 2023-03-15 종가/상장주식수
  const krxRes = await fetch(`${KRX_BASE_URL}?basDd=20230315`, { headers: { AUTH_KEY: krxKey } });
  const krxBody = (await krxRes.json()) as {
    OutBlock_1?: { ISU_CD: string; ISU_NM: string; TDD_CLSPRC: string; LIST_SHRS: string; MKTCAP: string }[];
  };
  const samsungRow = krxBody.OutBlock_1?.find((row) => row.ISU_CD === "005930");
  console.log("KRX 2023-03-15 005930 행:", JSON.stringify(samsungRow));
  if (!samsungRow) throw new Error("KRX 응답에서 005930을 찾지 못했습니다.");

  const closePrice = Number(samsungRow.TDD_CLSPRC);
  const listedShares = Number(samsungRow.LIST_SHRS);
  console.log(`종가: ${closePrice}원, 상장주식수: ${listedShares}주`);

  // 2) DART에서 FY2022 지배기업 소유주지분 당기순이익/자본총계 (rcept_no 20230307, 테스트일 이전)
  const { data: corpRow, error: corpError } = await supabaseAdmin
    .from("dart_corp_codes")
    .select("corp_code")
    .eq("stock_code", "005930")
    .maybeSingle();
  if (corpError || !corpRow) throw new Error(`corp_code 조회 실패: ${corpError?.message}`);

  const dartUrl = new URL(`${DART_BASE_URL}/fnlttSinglAcntAll.json`);
  dartUrl.searchParams.set("crtfc_key", dartKey);
  dartUrl.searchParams.set("corp_code", corpRow.corp_code);
  dartUrl.searchParams.set("bsns_year", "2022");
  dartUrl.searchParams.set("reprt_code", "11011");
  dartUrl.searchParams.set("fs_div", "CFS");

  const dartRes = await fetch(dartUrl);
  const dartBody = (await dartRes.json()) as {
    list: { rcept_no: string; sj_div: string; account_id: string; account_nm: string; thstrm_amount: string }[];
  };

  const rceptNo = dartBody.list[0]?.rcept_no ?? "";
  const rceptDate = rceptNo.slice(0, 8);
  console.log(`\nDART 접수번호: ${rceptNo} (접수일자 ${rceptDate}) — 테스트일 20230315보다 이전인가: ${rceptDate <= "20230315"}`);

  const netIncomeRow = dartBody.list.find(
    (r) => r.account_id === "ifrs-full_ProfitLossAttributableToOwnersOfParent"
  );
  const equityRow = dartBody.list.find(
    (r) => r.account_id === "ifrs-full_EquityAttributableToOwnersOfParent"
  );
  if (!netIncomeRow || !equityRow) throw new Error("DART 응답에서 지배기업 소유주지분 항목을 찾지 못했습니다.");

  const netIncome = Number(netIncomeRow.thstrm_amount);
  const equity = Number(equityRow.thstrm_amount);
  console.log(`지배기업 소유주지분 당기순이익(FY2022): ${netIncome}원`);
  console.log(`지배기업 소유주지분 자본총계(FY2022): ${equity}원`);

  // 3) PER/PBR 계산
  const eps = netIncome / listedShares;
  const bps = equity / listedShares;
  const per = closePrice / eps;
  const pbr = closePrice / bps;

  console.log(`\nEPS(KRX 상장주식수 기준): ${eps.toFixed(2)}원`);
  console.log(`BPS(KRX 상장주식수 기준): ${bps.toFixed(2)}원`);
  console.log(`=== 2023-03-15 기준 재구성 PER: ${per.toFixed(2)}배 ===`);
  console.log(`=== 2023-03-15 기준 재구성 PBR: ${pbr.toFixed(2)}배 ===`);
}

main().catch((error) => {
  console.error("확인 중 오류:", error);
  process.exit(1);
});
