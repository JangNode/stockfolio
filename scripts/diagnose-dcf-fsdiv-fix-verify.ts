/**
 * (임시) DCF에 fs_div(CFS/OFS) 일치 검사를 추가한 후 실데이터로 검증한다.
 * 1) 삼성전자(005930) 등 fs_div 일치 종목 1~2개로 WACC·FCF성장률·적정주가가
 *    합리적인 값으로 계산되는지 확인한다(회귀 확인 — 이번 변경으로 정상 케이스가
 *    깨지지 않았는지).
 * 2) diagnose-dcf-coverage.ts에서 fs_div 불일치로 확인된 종목(016790) 하나를
 *    실제로 돌려, 새로 추가한 "산출 불가" 사유가 의도대로 나오는지 확인한다.
 *
 * 읽기 전용. 확인 후 즉시 삭제 예정.
 * tsx --conditions=react-server scripts/diagnose-dcf-fsdiv-fix-verify.ts
 */
import { getStockPrice } from "@/lib/kis";
import { getStockBeta } from "@/lib/stockBetaStorage";
import { computeRequiredReturnPct } from "@/lib/capm";
import { getEcosSeries } from "@/lib/ecosClient";
import { getCashflowStatements, getDebtStructure } from "@/lib/dartCashflowDebtStorage";
import { computeDcfFairValue } from "@/lib/dcfValuation";

const ECOS_RISK_FREE_LOOKBACK_DAYS = 30;

function yyyymmddDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

async function verify(code: string, label: string): Promise<void> {
  console.log(`\n---------- ${label}(${code}) ----------`);
  const today = yyyymmddDaysAgo(0);
  const [price, betaRow, riskFreeSeries, cashflowRows, debtRows] = await Promise.all([
    getStockPrice(code),
    getStockBeta(code),
    getEcosSeries("817Y002", "010210000", yyyymmddDaysAgo(ECOS_RISK_FREE_LOOKBACK_DAYS), today),
    getCashflowStatements(code),
    getDebtStructure(code),
  ]);

  const riskFreeRatePct = riskFreeSeries.length > 0 ? riskFreeSeries[riskFreeSeries.length - 1].value : null;
  const requiredReturnPct =
    betaRow?.beta != null && riskFreeRatePct !== null ? computeRequiredReturnPct(riskFreeRatePct, betaRow.beta) : null;

  console.log(`현재가: ${price.currentPrice}원, 시총: ${price.marketCapEok}억원, 발행주식수: ${price.sharesOutstanding}`);
  console.log(`베타: ${betaRow?.beta}, 무위험이자율: ${riskFreeRatePct}%, CAPM 요구수익률: ${requiredReturnPct}%`);
  console.log(
    `현금흐름 데이터: ${cashflowRows.length}개년 (${cashflowRows.map((r) => `FY${r.fiscalYear}:${r.fsDiv}`).join(", ")})`
  );
  console.log(`부채구조 데이터: ${debtRows.length}개년`);

  const result = computeDcfFairValue({
    currentPrice: price.currentPrice,
    sharesOutstanding: price.sharesOutstanding,
    marketCapEok: price.marketCapEok,
    cashflowRows,
    debtRows,
    beta: betaRow?.beta ?? null,
    riskFreeRatePct,
    requiredReturnPct,
  });

  console.log("DCF 결과:", JSON.stringify(result, null, 2));
}

async function main(): Promise<void> {
  console.log("########## DCF fs_div 수정 후 실데이터 검증 ##########");
  // fs_div 일치(정상 케이스) 회귀 확인 — 이미 확인 완료(삼성전자/SK하이닉스 둘 다
  // 정상 계산됨). 이번 재실행은 fs_div 불일치 종목 확인에만 집중한다.

  // 016790은 베타 산출 불가(상장 3년 미만 등)로 fs_div 검사 이전 단계에서 이미
  // UNKNOWN 처리돼, fs_div 검사 로직 자체가 실행되는지 확인하지 못했다.
  // diagnose-dcf-coverage.ts가 찾은 나머지 fs_div 불일치 종목을 순서대로 시도해
  // 베타가 있어 fs_div 검사까지 도달하는 종목을 찾는다.
  const fsDivMismatchCandidates = [
    "047920",
    "056080",
    "114190",
    "141080",
    "166090",
    "187660",
    "195940",
    "199800",
    "225570",
    "256840",
    "271940",
    "281820",
    "302440",
    "307750",
    "347700",
    "388720",
  ];
  for (const code of fsDivMismatchCandidates) {
    await verify(code, "fs_div 불일치 종목");
  }
  console.log("\n=== 검증 종료 ===");
}

main().catch((error) => {
  console.error("검증 중 오류:", error);
  process.exit(1);
});
