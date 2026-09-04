/**
 * 관심종목 적정주가 2단계(DCF) 착수 전 사전 확인. 0단계(DART 현금흐름표/부채구조
 * 백필)가 실제로 dart_cashflow_statements/dart_debt_structure에 5개년 데이터를
 * 얼마나 채웠는지 실측한다 — 사용자가 명시적으로 "시작하기 전에 먼저 확인해달라"고
 * 요청했다.
 *
 * 확인 항목:
 * 1) 두 표 각각 종목당 몇 개년치가 쌓여 있는지 분포(5개년 이상/미만)
 * 2) DCF 계산에 필수인 필드(operating_cf, capex / short_term_debt, long_term_debt,
 *    bonds_payable, interest_expense)의 null 비율
 * 3) 두 표 모두 5개년 이상 + 필수 필드가 채워진 "DCF 산출 가능 종목" 수
 * 4) 표본 종목(삼성전자 005930, SK하이닉스 000660) 원자료를 그대로 출력해 WACC
 *    예시 계산에 쓸 수 있게 한다(FCF, 이자비용/이자부채, 베타/무위험이자율 재사용)
 *
 * DB에는 아무것도 쓰지 않는 읽기 전용 진단.
 *
 * 필요 환경변수: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ECOS_API_KEY
 *   tsx --conditions=react-server scripts/diagnose-dcf-data-coverage.ts
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getStockBeta } from "@/lib/stockBetaStorage";
import { getEcosSeries } from "@/lib/ecosClient";
import { computeRequiredReturnPct } from "@/lib/capm";
import { DART_VALUATION_FISCAL_YEARS } from "@/lib/dartValuationConfig";

const SAMPLE_STOCK_CODES = ["005930", "000660"];

function yyyymmddDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

interface CoverageRow {
  stock_code: string;
  fiscal_year: number;
  [key: string]: unknown;
}

async function fetchAll(table: string, columns: string): Promise<CoverageRow[]> {
  const rows: CoverageRow[] = [];
  let from = 0;
  const PAGE = 1000;
  for (;;) {
    const { data, error } = await supabaseAdmin
      .from(table)
      .select(columns)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`${table} 조회 실패: ${error.message}`);
    if (!data || data.length === 0) break;
    rows.push(...(data as unknown as CoverageRow[]));
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return rows;
}

function summarizeCoverage(label: string, rows: CoverageRow[], requiredFields: string[]): Set<string> {
  const yearsByStock = new Map<string, Set<number>>();
  const nullCountByField = new Map<string, number>(requiredFields.map((f) => [f, 0]));

  for (const row of rows) {
    const set = yearsByStock.get(row.stock_code) ?? new Set<number>();
    set.add(row.fiscal_year);
    yearsByStock.set(row.stock_code, set);
    for (const field of requiredFields) {
      if (row[field] === null || row[field] === undefined) {
        nullCountByField.set(field, (nullCountByField.get(field) ?? 0) + 1);
      }
    }
  }

  const totalStocks = yearsByStock.size;
  let atLeastFive = 0;
  const stocksWithFiveYears = new Set<string>();
  for (const [code, years] of yearsByStock) {
    if (years.size >= DART_VALUATION_FISCAL_YEARS) {
      atLeastFive++;
      stocksWithFiveYears.add(code);
    }
  }

  console.log(`\n--- ${label} ---`);
  console.log(`총 행 수: ${rows.length}, 종목 수: ${totalStocks}`);
  console.log(`${DART_VALUATION_FISCAL_YEARS}개년 이상 데이터 보유 종목: ${atLeastFive}개 (${totalStocks > 0 ? ((atLeastFive / totalStocks) * 100).toFixed(1) : 0}%)`);
  for (const field of requiredFields) {
    const nullCount = nullCountByField.get(field) ?? 0;
    console.log(`  ${field} null 비율: ${nullCount}/${rows.length} (${rows.length > 0 ? ((nullCount / rows.length) * 100).toFixed(1) : 0}%)`);
  }

  // 연도 수 분포(0~1년, 2~3년, 4년, 5년+)를 대략적으로 보여준다.
  const bucket = { "1": 0, "2-3": 0, "4": 0, [`${DART_VALUATION_FISCAL_YEARS}+`]: 0 };
  for (const years of yearsByStock.values()) {
    const n = years.size;
    if (n <= 1) bucket["1"]++;
    else if (n <= 3) bucket["2-3"]++;
    else if (n === 4) bucket["4"]++;
    else bucket[`${DART_VALUATION_FISCAL_YEARS}+`]++;
  }
  console.log(`  종목당 보유 연도 수 분포: ${JSON.stringify(bucket)}`);

  return stocksWithFiveYears;
}

async function diagnoseSample(stockCode: string): Promise<void> {
  console.log(`\n########## 표본 종목 원자료: ${stockCode} ##########`);

  const { data: cashflowRows, error: cfError } = await supabaseAdmin
    .from("dart_cashflow_statements")
    .select("fiscal_year, fs_div, operating_cf, investing_cf, capex, financing_cf, rcept_date")
    .eq("stock_code", stockCode)
    .order("fiscal_year", { ascending: true });
  if (cfError) throw new Error(`cashflow 조회 실패: ${cfError.message}`);
  console.log("dart_cashflow_statements:", JSON.stringify(cashflowRows));

  const { data: debtRows, error: debtError } = await supabaseAdmin
    .from("dart_debt_structure")
    .select("fiscal_year, fs_div, short_term_debt, long_term_debt, bonds_payable, interest_expense, rcept_date")
    .eq("stock_code", stockCode)
    .order("fiscal_year", { ascending: true });
  if (debtError) throw new Error(`debt 조회 실패: ${debtError.message}`);
  console.log("dart_debt_structure:", JSON.stringify(debtRows));

  if (!cashflowRows || cashflowRows.length === 0 || !debtRows || debtRows.length === 0) {
    console.log("데이터 부족으로 예시 계산 생략.");
    return;
  }

  // FCF = 영업활동현금흐름 - capex, 연도별로 계산.
  const fcfByYear = (cashflowRows as { fiscal_year: number; operating_cf: number | null; capex: number | null }[])
    .filter((r) => r.operating_cf !== null && r.capex !== null)
    .map((r) => ({ year: r.fiscal_year, fcf: (r.operating_cf as number) - (r.capex as number) }));
  console.log("연도별 FCF(영업CF - capex):", JSON.stringify(fcfByYear));

  if (fcfByYear.length >= 2) {
    const first = fcfByYear[0].fcf;
    const last = fcfByYear[fcfByYear.length - 1].fcf;
    const years = fcfByYear.length - 1;
    if (first > 0 && last > 0) {
      const cagr = (Math.pow(last / first, 1 / years) - 1) * 100;
      console.log(`FCF CAGR(첫해→마지막해, ${years}년): ${cagr.toFixed(2)}%`);
    } else {
      console.log(`FCF CAGR 계산 불가(첫해 또는 마지막해 FCF가 음수: first=${first}, last=${last})`);
    }
  }

  const latestDebt = (debtRows as { short_term_debt: number | null; long_term_debt: number | null; bonds_payable: number | null; interest_expense: number | null }[])[debtRows.length - 1];
  const totalInterestBearingDebt = (latestDebt.short_term_debt ?? 0) + (latestDebt.long_term_debt ?? 0) + (latestDebt.bonds_payable ?? 0);
  console.log(`최근년도 총 이자부채(단기+장기+사채): ${totalInterestBearingDebt}`);
  console.log(`최근년도 이자비용(이자의 지급, 현금기준): ${latestDebt.interest_expense}`);
  if (latestDebt.interest_expense !== null && totalInterestBearingDebt > 0) {
    const costOfDebt = (latestDebt.interest_expense / totalInterestBearingDebt) * 100;
    console.log(`타인자본비용(이자비용/총이자부채): ${costOfDebt.toFixed(2)}%`);
  } else {
    console.log("타인자본비용 계산 불가(이자비용 null 또는 총 이자부채 0).");
  }

  // 자기자본비용(RIM 1단계 재사용): 베타 + 무위험이자율.
  const betaRow = await getStockBeta(stockCode);
  const riskFreeSeries = await getEcosSeries("817Y002", "010210000", yyyymmddDaysAgo(30), yyyymmddDaysAgo(0));
  const riskFreeRatePct = riskFreeSeries.length > 0 ? riskFreeSeries[riskFreeSeries.length - 1].value : null;
  console.log(`베타(RIM 재사용): ${betaRow?.beta ?? "산출 불가"}, 무위험이자율: ${riskFreeRatePct}`);
  if (betaRow?.beta != null && riskFreeRatePct !== null) {
    const costOfEquity = computeRequiredReturnPct(riskFreeRatePct, betaRow.beta);
    console.log(`자기자본비용(CAPM, RIM 요구수익률 재사용): ${costOfEquity.toFixed(2)}%`);
  }
}

async function main(): Promise<void> {
  console.log("########## 1. dart_cashflow_statements 커버리지 ##########");
  const cashflowRows = await fetchAll("dart_cashflow_statements", "stock_code, fiscal_year, operating_cf, capex");
  const cfFiveYearStocks = summarizeCoverage("dart_cashflow_statements", cashflowRows, ["operating_cf", "capex"]);

  console.log("\n########## 2. dart_debt_structure 커버리지 ##########");
  const debtRows = await fetchAll(
    "dart_debt_structure",
    "stock_code, fiscal_year, short_term_debt, long_term_debt, bonds_payable, interest_expense"
  );
  const debtFiveYearStocks = summarizeCoverage("dart_debt_structure", debtRows, [
    "short_term_debt",
    "long_term_debt",
    "bonds_payable",
    "interest_expense",
  ]);

  const bothFiveYears = [...cfFiveYearStocks].filter((code) => debtFiveYearStocks.has(code));
  console.log(`\n########## 3. 두 표 모두 ${DART_VALUATION_FISCAL_YEARS}개년 이상 보유한 종목 ##########`);
  console.log(`${bothFiveYears.length}개: ${JSON.stringify(bothFiveYears.slice(0, 30))}${bothFiveYears.length > 30 ? " ... (30개만 표시)" : ""}`);

  for (const code of SAMPLE_STOCK_CODES) {
    await diagnoseSample(code);
  }

  console.log("\n=== 진단 종료 ===");
}

main().catch((error) => {
  console.error("진단 스크립트 실행 중 오류:", error);
  process.exit(1);
});
