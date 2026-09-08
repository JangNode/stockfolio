/**
 * (임시) PEG의 computeEpsCagr에 fs_div 일치 검사를 추가하면서, 실제로 "오늘" 기준
 * PEG가 새로 산출 불가(null)로 바뀌는 종목 수를 확인한다.
 *
 * lib/pegRatio.ts의 selectEpsCagrFiscalYears와 동일한 방식으로 종목별
 * end=최신 회계연도, start=end-PEG_GROWTH_LOOKBACK_YEARS를 고르고, 두 연도의
 * fs_div가 다른 경우를 센다. 그중 순이익이 둘 다 양수인 경우(상장주식수가
 * 양수라고 가정하면 EPS도 양수라 기존엔 실제 성장률 숫자가 나왔을 가능성이 높은
 * 케이스)만 별도로 집계해, "이번 수정으로 진짜 바뀌는" 종목 수를 가늠한다.
 *
 * 읽기 전용, DB만 조회하고 아무것도 쓰지 않는다. 확인 후 즉시 삭제 예정.
 * tsx --conditions=react-server scripts/diagnose-peg-fs-div-impact.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { PEG_GROWTH_LOOKBACK_YEARS } from "@/lib/pegConfig";

interface Row {
  stock_code: string;
  fiscal_year: number;
  fs_div: string;
  net_income_parent: number | null;
}

async function main(): Promise<void> {
  console.log("########## stock_annual_fundamentals 로드 ##########");
  const allRows: Row[] = [];
  let from = 0;
  const PAGE = 1000;
  for (;;) {
    const { data, error } = await supabaseAdmin
      .from("stock_annual_fundamentals")
      .select("stock_code, fiscal_year, fs_div, net_income_parent")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    allRows.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
    from += PAGE;
  }

  const byStock = new Map<string, Row[]>();
  for (const row of allRows) {
    const list = byStock.get(row.stock_code) ?? [];
    list.push(row);
    byStock.set(row.stock_code, list);
  }

  let bothEndpointsExist = 0;
  let fsDivMismatch = 0;
  let mismatchWithBothPositiveIncome = 0;
  const mismatchExamples: string[] = [];

  for (const [stockCode, rows] of byStock) {
    const end = rows.reduce((max, r) => (r.fiscal_year > max.fiscal_year ? r : max), rows[0]);
    const start = rows.find((r) => r.fiscal_year === end.fiscal_year - PEG_GROWTH_LOOKBACK_YEARS);
    if (!start) continue;
    bothEndpointsExist++;

    if (start.fs_div !== end.fs_div) {
      fsDivMismatch++;
      const bothPositive =
        start.net_income_parent !== null && start.net_income_parent > 0 &&
        end.net_income_parent !== null && end.net_income_parent > 0;
      if (bothPositive) {
        mismatchWithBothPositiveIncome++;
        if (mismatchExamples.length < 10) {
          mismatchExamples.push(
            `${stockCode}: FY${start.fiscal_year}(${start.fs_div}, 순이익 ${(start.net_income_parent! / 1e8).toFixed(1)}억) -> FY${end.fiscal_year}(${end.fs_div}, 순이익 ${(end.net_income_parent! / 1e8).toFixed(1)}억)`
          );
        }
      }
    }
  }

  console.log(`\n########## 결과(PEG_GROWTH_LOOKBACK_YEARS=${PEG_GROWTH_LOOKBACK_YEARS}) ##########`);
  console.log(`  시작/끝 연도 데이터가 둘 다 있는 종목(PEG 계산 시도 대상): ${bothEndpointsExist}개`);
  console.log(`  그중 fs_div가 다른 종목(이번 수정으로 null): ${fsDivMismatch}개`);
  console.log(`  그중 순이익이 양쪽 다 양수(상장주식수 양수 가정 시 기존엔 실숫값이 나왔을 가능성 높음): ${mismatchWithBothPositiveIncome}개`);
  console.log("\n  --- 예시(최대 10개) ---");
  for (const ex of mismatchExamples) console.log(`  ${ex}`);

  console.log("\n=== 확인 종료 ===");
}

main().catch((error) => {
  console.error("확인 중 오류:", error);
  process.exit(1);
});
