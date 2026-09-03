/**
 * scripts/backfill-dart-cashflow-debt.ts 백필 결과를 사람이 눈으로 검증하기 위한
 * 디스포저블 스크립트. 특정 종목(기본 삼성전자 005930)의 dart_cashflow_statements
 * 전체 연도를 조회해 fcf(=operating_cf - capex)를 계산해 출력하고, 각 행의
 * rcept_no로 DART 공시 원문 URL도 같이 출력한다(사람이 공시와 대조할 수 있게).
 * dart_debt_structure도 같은 방식으로 출력한다.
 *
 * DB에는 아무것도 쓰지 않는 읽기 전용 검증 — 검증이 끝나면 정리 PR에서 삭제한다.
 *
 * 필요 환경변수: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   tsx --conditions=react-server scripts/verify-dart-cashflow-debt.ts [stock_code]
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";

const DART_FILING_URL_BASE = "https://dart.fss.or.kr/dsaf001/main.do?rcpNo=";

async function main(): Promise<void> {
  const stockCode = process.argv[2] ?? "005930";

  console.log(`\n########## dart_cashflow_statements — ${stockCode} ##########`);
  const { data: cashflowRows, error: cashflowError } = await supabaseAdmin
    .from("dart_cashflow_statements")
    .select("*")
    .eq("stock_code", stockCode)
    .order("fiscal_year", { ascending: true });
  if (cashflowError) throw new Error(`dart_cashflow_statements 조회 실패: ${cashflowError.message}`);
  if (!cashflowRows || cashflowRows.length === 0) {
    console.log("  데이터 없음(백필이 아직 안 됐거나 대상 종목이 아닐 수 있음)");
  }
  for (const row of cashflowRows ?? []) {
    const fcf = row.operating_cf != null && row.capex != null ? row.operating_cf - row.capex : null;
    console.log(
      `  FY${row.fiscal_year} fs_div=${row.fs_div} 영업CF=${row.operating_cf} 투자CF=${row.investing_cf} ` +
        `재무CF=${row.financing_cf} capex=${row.capex} FCF=${fcf}`
    );
    console.log(`    공시 원문: ${DART_FILING_URL_BASE}${row.rcept_no} (접수일 ${row.rcept_date})`);
  }

  console.log(`\n########## dart_debt_structure — ${stockCode} ##########`);
  const { data: debtRows, error: debtError } = await supabaseAdmin
    .from("dart_debt_structure")
    .select("*")
    .eq("stock_code", stockCode)
    .order("fiscal_year", { ascending: true });
  if (debtError) throw new Error(`dart_debt_structure 조회 실패: ${debtError.message}`);
  if (!debtRows || debtRows.length === 0) {
    console.log("  데이터 없음(백필이 아직 안 됐거나 대상 종목이 아닐 수 있음)");
  }
  for (const row of debtRows ?? []) {
    console.log(
      `  FY${row.fiscal_year} fs_div=${row.fs_div} 단기차입금=${row.short_term_debt} ` +
        `장기차입금=${row.long_term_debt} 사채=${row.bonds_payable} 이자지급=${row.interest_expense}`
    );
    console.log(`    공시 원문: ${DART_FILING_URL_BASE}${row.rcept_no} (접수일 ${row.rcept_date})`);
  }

  console.log("\n=== 검증 종료 ===");
}

main().catch((error) => {
  console.error("검증 스크립트 실행 중 오류:", error);
  process.exit(1);
});
