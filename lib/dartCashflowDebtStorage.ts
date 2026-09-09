import "server-only";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

/**
 * DCF(현금흐름할인법) 계산에 쓰는 dart_cashflow_statements/dart_debt_structure
 * 종목별 조회(server-only). 배치(scripts/backfill-dart-cashflow-debt.ts)가 미리
 * 채워둔 표를 조회만 한다.
 */

export interface CashflowStatementRow {
  fiscalYear: number;
  fsDiv: "CFS" | "OFS";
  operatingCf: number | null;
  capex: number | null;
}

interface CashflowStatementDbRow {
  fiscal_year: number;
  fs_div: "CFS" | "OFS";
  operating_cf: number | string | null;
  capex: number | string | null;
}

export interface DebtStructureRow {
  fiscalYear: number;
  shortTermDebt: number | null;
  longTermDebt: number | null;
  bondsPayable: number | null;
  interestExpense: number | null;
}

interface DebtStructureDbRow {
  fiscal_year: number;
  short_term_debt: number | string | null;
  long_term_debt: number | string | null;
  bonds_payable: number | string | null;
  interest_expense: number | string | null;
}

/** fiscal_year 오름차순(과거→최근)으로 반환한다. */
export async function getCashflowStatements(stockCode: string): Promise<CashflowStatementRow[]> {
  const { data, error } = await supabaseAdmin
    .from("dart_cashflow_statements")
    .select("fiscal_year, fs_div, operating_cf, capex")
    .eq("stock_code", stockCode)
    .order("fiscal_year", { ascending: true });
  if (error) throw new Error(`${stockCode} 현금흐름표 조회 실패: ${error.message}`);
  return ((data ?? []) as CashflowStatementDbRow[]).map((row) => ({
    fiscalYear: row.fiscal_year,
    fsDiv: row.fs_div,
    operatingCf: row.operating_cf === null ? null : Number(row.operating_cf),
    capex: row.capex === null ? null : Number(row.capex),
  }));
}

/** fiscal_year 오름차순(과거→최근)으로 반환한다. */
export async function getDebtStructure(stockCode: string): Promise<DebtStructureRow[]> {
  const { data, error } = await supabaseAdmin
    .from("dart_debt_structure")
    .select("fiscal_year, short_term_debt, long_term_debt, bonds_payable, interest_expense")
    .eq("stock_code", stockCode)
    .order("fiscal_year", { ascending: true });
  if (error) throw new Error(`${stockCode} 부채구조 조회 실패: ${error.message}`);
  return ((data ?? []) as DebtStructureDbRow[]).map((row) => ({
    fiscalYear: row.fiscal_year,
    shortTermDebt: row.short_term_debt === null ? null : Number(row.short_term_debt),
    longTermDebt: row.long_term_debt === null ? null : Number(row.long_term_debt),
    bondsPayable: row.bonds_payable === null ? null : Number(row.bonds_payable),
    interestExpense: row.interest_expense === null ? null : Number(row.interest_expense),
  }));
}
