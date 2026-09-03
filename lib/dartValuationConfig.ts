/**
 * RIM/DCF 적정주가 계산용 선행 데이터(현금흐름표, 부채구조) 수집에 쓰는 계정과목
 * 매핑. RULES.md 2번(기준값은 상수로 분리, 출처 주석)에 따라 여기 둔다.
 *
 * 아래 account_id들은 2026-09-03 삼성전자(005930)/SK하이닉스(000660)/현대차(005380)
 * 3사 FY2025 사업보고서(DART fnlttSinglAcntAll)를 실제로 호출해 확인한 값이다
 * (scripts/diagnose-dart-cashflow-debt-accounts.ts, GitHub Actions 실행 결과 —
 * 추측이 아니라 실측).
 *
 * 후보 목록 방식(첫 매치 사용)을 쓴다 — 같은 개념이라도 회사마다 다른 표준계정코드를
 * 쓰는 경우가 실측으로 확인돼서다(예: 장기차입금은 SK하이닉스가
 * LongtermBorrowings, 현대차/삼성전자는 NoncurrentPortionOfNoncurrentLoansReceived).
 * 계정과목명(account_nm) 텍스트 유사도로 억지로 매칭하지 않는다 — 후보 코드에 없으면
 * null 처리하고 로그만 남긴다(scripts/backfill-dart-cashflow-debt.ts 참고).
 */

// 최근 몇 개년치 사업보고서를 대상으로 수집할지. stock_annual_fundamentals(1단계)보다
// 짧게 잡는다 — RIM/DCF는 최근 실적 흐름이 중요하고, 과거로 갈수록 IFRS 계정과목
// 표기가 더 달라져 매칭 실패가 늘어난다.
export const DART_VALUATION_FISCAL_YEARS = 5;

export const OPERATING_CF_ACCOUNT_IDS = ["ifrs-full_CashFlowsFromUsedInOperatingActivities"];
export const INVESTING_CF_ACCOUNT_IDS = ["ifrs-full_CashFlowsFromUsedInInvestingActivities"];
export const FINANCING_CF_ACCOUNT_IDS = ["ifrs-full_CashFlowsFromUsedInFinancingActivities"];
export const CAPEX_ACCOUNT_IDS = ["ifrs-full_PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities"];

export const SHORT_TERM_DEBT_ACCOUNT_IDS = [
  "ifrs-full_ShorttermBorrowings",
  "ifrs-full_CurrentBorrowingsAndCurrentPortionOfNoncurrentBorrowings",
];
export const LONG_TERM_DEBT_ACCOUNT_IDS = [
  "ifrs-full_LongtermBorrowings",
  "ifrs-full_NoncurrentPortionOfNoncurrentLoansReceived",
];
export const BONDS_PAYABLE_ACCOUNT_IDS = ["ifrs-full_NoncurrentPortionOfNoncurrentBondsIssued"];

// 손익계산서(IS) 요약 항목에는 이자비용이 별도로 없다(2026-09-03 3사 실측 전부 0건
// 확인 — scripts/diagnose-dart-cashflow-debt-accounts.ts 결과). 대신 현금흐름표(CF)
// 영업활동 섹션의 "이자의 지급"(현금 기준 실제 지급액)을 이자비용 근사치로 쓴다 —
// 사용자 확인 완료(2026-09-03).
export const INTEREST_EXPENSE_ACCOUNT_IDS = ["ifrs-full_InterestPaidClassifiedAsOperatingActivities"];
