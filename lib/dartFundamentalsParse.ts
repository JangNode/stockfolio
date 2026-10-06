/**
 * DART fnlttSinglAcntAll(단일회사 전체 재무제표) 응답에서 지배주주 순이익/자본을 뽑는 순수 파서(DB·네트워크 접근 없음).
 *
 * 계정 id 표기가 연도에 따라 다르다: FY2015~2018은 `ifrs_…`, FY2019부터는 `ifrs-full_…`(2026-10-06 실측, 삼성전자
 * /카카오 등). 이전에는 후자만 읽어 FY2015~2018 지배주주순이익이 거의 전부 NULL로 저장됐다. 두 표기를 모두 읽고, 그래도
 * 없으면(예: 카카오 FY2015~2016) 계정명으로 폴백한다. 우선순위(지배 계정 id → 전체 손익/자본 id → 계정명)는 기존 동작과
 * 같은 순서를 유지한다(기존에 값이 나오던 경우의 결과가 바뀌지 않게).
 */

export interface DartAccountRow {
  rcept_no: string;
  sj_div: string;
  account_id: string;
  account_nm?: string;
  thstrm_amount: string;
}

export interface ParsedFundamentals {
  rceptNo: string;
  rceptDate: string;
  netIncomeParent: number | null;
  equityParent: number | null;
}

const NET_INCOME_PARENT_ACCOUNT_IDS = [
  "ifrs-full_ProfitLossAttributableToOwnersOfParent",
  "ifrs_ProfitLossAttributableToOwnersOfParent",
];
const EQUITY_PARENT_ACCOUNT_IDS = [
  "ifrs-full_EquityAttributableToOwnersOfParent",
  "ifrs_EquityAttributableToOwnersOfParent",
];
// 지배/비지배 구분이 없는 회사는 전체 당기순이익/자본총계를 쓴다(비지배지분이 없으니 전체=지배지분).
const NET_INCOME_TOTAL_ACCOUNT_IDS = ["ifrs-full_ProfitLoss", "ifrs_ProfitLoss"];
const EQUITY_TOTAL_ACCOUNT_IDS = ["ifrs-full_Equity", "ifrs_Equity"];
// 손익계산서(IS) 또는 포괄손익계산서(CIS) — 단일 포괄손익계산서를 쓰는 회사는 CIS로 내려온다.
const INCOME_STATEMENT_DIVS = ["IS", "CIS"];
const BALANCE_SHEET_DIV = "BS";

function normalizeName(name: string | undefined): string {
  return (name ?? "").replace(/\s+/g, "");
}

// 지배기업 소유주 몫 계정명(예: "지배기업 소유주지분", "지배기업의 소유주에게 귀속되는 당기순이익"). 비지배지분은 제외.
function isParentOwnerName(name: string | undefined): boolean {
  const n = normalizeName(name);
  return n.includes("지배") && n.includes("소유주") && !n.includes("비지배");
}

function findById(list: DartAccountRow[], ids: readonly string[], sjDivs?: readonly string[]): DartAccountRow | undefined {
  for (const id of ids) {
    const row = list.find((r) => r.account_id === id && (!sjDivs || sjDivs.includes(r.sj_div)));
    if (row) return row;
  }
  return undefined;
}

function toNumber(raw: string): number | null {
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function parseFundamentalsList(list: DartAccountRow[]): ParsedFundamentals {
  const rceptNo = list[0].rcept_no;

  const netIncomeSource =
    findById(list, NET_INCOME_PARENT_ACCOUNT_IDS) ??
    findById(list, NET_INCOME_TOTAL_ACCOUNT_IDS, INCOME_STATEMENT_DIVS) ??
    list.find((r) => INCOME_STATEMENT_DIVS.includes(r.sj_div) && isParentOwnerName(r.account_nm) && r.thstrm_amount !== "");
  const equitySource =
    findById(list, EQUITY_PARENT_ACCOUNT_IDS) ??
    findById(list, EQUITY_TOTAL_ACCOUNT_IDS, [BALANCE_SHEET_DIV]) ??
    list.find((r) => r.sj_div === BALANCE_SHEET_DIV && isParentOwnerName(r.account_nm) && r.thstrm_amount !== "");

  return {
    rceptNo,
    rceptDate: `${rceptNo.slice(0, 4)}-${rceptNo.slice(4, 6)}-${rceptNo.slice(6, 8)}`,
    netIncomeParent: netIncomeSource ? toNumber(netIncomeSource.thstrm_amount) : null,
    equityParent: equitySource ? toNumber(equitySource.thstrm_amount) : null,
  };
}
