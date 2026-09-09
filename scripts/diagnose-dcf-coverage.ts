/**
 * (임시) DCF 2단계(FCF CAGR fs_div 일치 검사 추가) 착수 전 확인용 진단.
 *
 * 1) dart_cashflow_statements/dart_debt_structure에 실제로 몇 개 종목이
 *    DCF 계산 최소 요건(5개년 현금흐름 데이터)을 채우고 있는지 집계한다.
 *    백필 이력상 dart_cashflow_debt는 성공으로 기록돼 있지만, 2026-09-08
 *    재무제표 배치 사건(013 대량 발생이 성공으로 오기록된 사례)이 있었던
 *    만큼 실제 커버리지를 직접 세본다.
 * 2) dart_cashflow_statements에서, computeFcfGrowthRatePct가 실제로 쓰는
 *    "첫 해 vs 마지막 해"(5년 CAGR 시작·끝 연도)의 fs_div가 서로 다른
 *    종목이 몇 개인지 확인한다 — PEG의 fs_div 일치 검사와 동일한 패턴을
 *    DCF에도 적용할 때의 실제 영향 규모를 가늠하기 위함.
 *
 * 읽기 전용. 확인 후 즉시 삭제 예정.
 * tsx --conditions=react-server scripts/diagnose-dcf-coverage.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { DART_VALUATION_FISCAL_YEARS } from "@/lib/dartValuationConfig";

interface CashflowRow {
  stock_code: string;
  fiscal_year: number;
  fs_div: "CFS" | "OFS";
  operating_cf: number | string | null;
  capex: number | string | null;
}

interface DebtRow {
  stock_code: string;
  fiscal_year: number;
}

async function fetchAllCashflowRows(): Promise<CashflowRow[]> {
  const pageSize = 1000;
  let from = 0;
  const rows: CashflowRow[] = [];
  for (;;) {
    const { data, error } = await supabaseAdmin
      .from("dart_cashflow_statements")
      .select("stock_code, fiscal_year, fs_div, operating_cf, capex")
      .order("stock_code", { ascending: true })
      .order("fiscal_year", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`dart_cashflow_statements 조회 실패: ${error.message}`);
    if (!data || data.length === 0) break;
    rows.push(...(data as CashflowRow[]));
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

async function fetchAllDebtRows(): Promise<DebtRow[]> {
  const pageSize = 1000;
  let from = 0;
  const rows: DebtRow[] = [];
  for (;;) {
    const { data, error } = await supabaseAdmin
      .from("dart_debt_structure")
      .select("stock_code, fiscal_year")
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`dart_debt_structure 조회 실패: ${error.message}`);
    if (!data || data.length === 0) break;
    rows.push(...(data as DebtRow[]));
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

async function main(): Promise<void> {
  console.log("########## DCF 선행데이터 커버리지 + fs_div 영향 확인 ##########\n");

  const [cashflowRows, debtRows] = await Promise.all([fetchAllCashflowRows(), fetchAllDebtRows()]);
  console.log(`dart_cashflow_statements 총 행 수: ${cashflowRows.length}`);
  console.log(`dart_debt_structure 총 행 수: ${debtRows.length}\n`);

  const byStockCashflow = new Map<string, CashflowRow[]>();
  for (const row of cashflowRows) {
    const list = byStockCashflow.get(row.stock_code) ?? [];
    list.push(row);
    byStockCashflow.set(row.stock_code, list);
  }

  const byStockDebt = new Map<string, DebtRow[]>();
  for (const row of debtRows) {
    const list = byStockDebt.get(row.stock_code) ?? [];
    list.push(row);
    byStockDebt.set(row.stock_code, list);
  }

  console.log(`현금흐름표 데이터 있는 종목 수(1개년 이상): ${byStockCashflow.size}`);
  console.log(`부채구조 데이터 있는 종목 수(1개년 이상): ${byStockDebt.size}\n`);

  let stocksWithFullFiscalYears = 0;
  let stocksWithFullFcfSeries = 0; // operating_cf/capex 둘 다 non-null인 행이 5개 이상
  let stocksWithBothTables5y = 0;
  let fsDivMismatchCount = 0;
  const fsDivMismatchExamples: string[] = [];

  for (const [stockCode, rows] of byStockCashflow) {
    rows.sort((a, b) => a.fiscal_year - b.fiscal_year);
    if (rows.length >= DART_VALUATION_FISCAL_YEARS) stocksWithFullFiscalYears++;

    const fcfRows = rows.filter((r) => r.operating_cf !== null && r.capex !== null);
    if (fcfRows.length >= DART_VALUATION_FISCAL_YEARS) {
      stocksWithFullFcfSeries++;

      const debtRowsForStock = byStockDebt.get(stockCode) ?? [];
      if (debtRowsForStock.length > 0) stocksWithBothTables5y++;

      // computeFcfGrowthRatePct는 fcfSeries의 첫 원소·마지막 원소만 쓴다(5개년
      // 전체가 아니라 시작/끝 두 연도) — 실제 계산 로직과 동일한 기준으로 확인.
      const first = fcfRows[0];
      const last = fcfRows[fcfRows.length - 1];
      if (first.fs_div !== last.fs_div) {
        fsDivMismatchCount++;
        if (fsDivMismatchExamples.length < 20) {
          fsDivMismatchExamples.push(
            `${stockCode}(FY${first.fiscal_year}:${first.fs_div} vs FY${last.fiscal_year}:${last.fs_div})`
          );
        }
      }
    }
  }

  console.log(`########## 결과 ##########`);
  console.log(`fiscal_year 행 수 ${DART_VALUATION_FISCAL_YEARS}개 이상인 종목: ${stocksWithFullFiscalYears}개`);
  console.log(
    `operating_cf/capex 둘 다 non-null인 FCF 산출 가능 행이 ${DART_VALUATION_FISCAL_YEARS}개 이상인 종목(DCF 최소 요건): ${stocksWithFullFcfSeries}개`
  );
  console.log(`(위 종목 중) dart_debt_structure에도 데이터가 있는 종목: ${stocksWithBothTables5y}개\n`);
  console.log(
    `DCF 최소 요건 통과 종목 중, FCF CAGR 시작·끝 연도의 fs_div가 다른 종목: ${fsDivMismatchCount}개 / ${stocksWithFullFcfSeries}개`
  );
  console.log(`예시(최대 20개): ${fsDivMismatchExamples.join(", ") || "없음"}`);
  console.log("\n=== 확인 종료 ===");
}

main().catch((error) => {
  console.error("확인 중 오류:", error);
  process.exit(1);
});
