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
 *
 * 2026-09-04 DCF 2단계 착수 전 커버리지 진단에서 long_term_debt(77.8%)/
 * bonds_payable(93.4%)이 대부분 null로 확인돼(3사만으로 확정한 후보 목록이 다른
 * 업종을 못 커버), long_term_debt/bonds_payable이 null인 종목 40개를 균등
 * 추출해 재진단했다(scripts/diagnose-dart-debt-account-tags.ts). 그 결과로
 * SHORT_TERM/LONG_TERM/BONDS_PAYABLE 후보를 확장했다(각 항목 옆 등장 빈도는
 * 40개 표본 기준). 일부 회사는 차입금 라인에 "(사채 포함)"이라고 명시해 사채를
 * 합산 신고한다 — 그런 회사는 사채가 차입금 계정에 섞여 별도 분리가 불가능하지만,
 * WACC은 세 필드의 합계(총 이자부채)만 쓰므로 합계 자체는 왜곡되지 않는다.
 * "-표준계정코드 미사용-"(DART가 표준 IFRS 태그를 못 준 항목)은 account_id가
 * 없어 이 방식으로는 원천적으로 매칭 불가능하다 — 텍스트 매칭은 하지 않기로 한
 * 기존 방침을 유지한다.
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
  // 아래 2개는 2026-09-04 40개 표본 재진단으로 추가(유동성장기차입금 8/40,
  // 단기차입금 2/40).
  "ifrs-full_CurrentPortionOfLongtermBorrowings",
  "ifrs-full_CurrentLoansReceivedAndCurrentPortionOfNoncurrentLoansReceived",
];
export const LONG_TERM_DEBT_ACCOUNT_IDS = [
  "ifrs-full_LongtermBorrowings",
  "ifrs-full_NoncurrentPortionOfNoncurrentLoansReceived",
  // 2026-09-04 40개 표본 재진단으로 추가(장기차입금 3/40).
  "dart_LongTermBorrowingsGross",
];
export const BONDS_PAYABLE_ACCOUNT_IDS = [
  "ifrs-full_NoncurrentPortionOfNoncurrentBondsIssued",
  // 아래 전부 2026-09-04 40개 표본 재진단으로 추가(사채 5/40, 유동성전환사채
  // 5/40, 교환사채/전환사채/신주인수권부사채류는 각 1~2/40이지만 사채의 특수
  // 형태라 누락 시 왜곡이 크므로 포함).
  "ifrs-full_BondsIssued",
  "dart_CurrentPortionOfConvertibleBonds",
  "dart_ConvertibleBonds",
  "dart_ConvertibleBondsNet",
  "dart_ExchangeableBondsNet",
  "dart_CurrentPortionOfExchangeableBond",
  "dart_BondWithWarrantNet",
  "dart_CurrentPortionOfBondWithWarrant",
];

// 손익계산서(IS) 요약 항목에는 이자비용이 별도로 없다(2026-09-03 3사 실측 전부 0건
// 확인 — scripts/diagnose-dart-cashflow-debt-accounts.ts 결과). 대신 현금흐름표(CF)
// 영업활동 섹션의 "이자의 지급"(현금 기준 실제 지급액)을 이자비용 근사치로 쓴다 —
// 사용자 확인 완료(2026-09-03).
export const INTEREST_EXPENSE_ACCOUNT_IDS = ["ifrs-full_InterestPaidClassifiedAsOperatingActivities"];
