/**
 * (임시) DH전략/PEG전략 백테스트 전 stock_annual_fundamentals의 CFS/OFS 혼재가
 * 계산을 왜곡하는지 확인한다. 연결(CFS)과 별도(OFS)는 자회사 포함 여부 때문에
 * 숫자 자체가 다를 수 있어, 같은 종목이 연도마다 CFS/OFS를 오가면 ROE/EPS 성장률이
 * 실제 변화가 아니라 기준 변경 때문에 튈 수 있다.
 *
 * 1) 종목 내에서 연도별 fs_div가 섞인(CFS/OFS 둘 다 있는) 케이스 수와 대표 사례.
 * 2) OFS만 있는 종목 수와, 정말로 전 연도 일관되게 OFS인지.
 *
 * 읽기 전용, DB만 조회하고 아무것도 쓰지 않는다. 확인 후 즉시 삭제 예정.
 * tsx --conditions=react-server scripts/diagnose-fs-div-mixing-impact.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";

interface Row {
  stock_code: string;
  fiscal_year: number;
  fs_div: string;
  net_income_parent: number | null;
  equity_parent: number | null;
}

async function main(): Promise<void> {
  console.log("########## 전체 stock_annual_fundamentals 로드 ##########");
  const allRows: Row[] = [];
  let from = 0;
  const PAGE = 1000;
  for (;;) {
    const { data, error } = await supabaseAdmin
      .from("stock_annual_fundamentals")
      .select("stock_code, fiscal_year, fs_div, net_income_parent, equity_parent")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    allRows.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
    from += PAGE;
  }
  console.log(`  총 ${allRows.length}행`);

  const byStock = new Map<string, Row[]>();
  for (const row of allRows) {
    const list = byStock.get(row.stock_code) ?? [];
    list.push(row);
    byStock.set(row.stock_code, list);
  }
  for (const list of byStock.values()) list.sort((a, b) => a.fiscal_year - b.fiscal_year);

  console.log(`  종목 수: ${byStock.size}`);

  const mixedStocks: string[] = [];
  const cfsOnlyStocks: string[] = [];
  const ofsOnlyStocks: string[] = [];

  for (const [stockCode, rows] of byStock) {
    const divs = new Set(rows.map((r) => r.fs_div));
    if (divs.size > 1) mixedStocks.push(stockCode);
    else if (divs.has("OFS")) ofsOnlyStocks.push(stockCode);
    else cfsOnlyStocks.push(stockCode);
  }

  console.log("\n########## 1. 종목 내 fs_div 혼재 ##########");
  console.log(`  혼재(CFS+OFS 둘 다 있음) 종목 수: ${mixedStocks.length}`);
  console.log(`  CFS만 있는 종목 수: ${cfsOnlyStocks.length}`);
  console.log(`  OFS만 있는 종목 수: ${ofsOnlyStocks.length}`);

  console.log("\n  --- 대표 사례(최대 5개, fs_div 전환 시점의 값 변화) ---");
  const sampleCount = Math.min(5, mixedStocks.length);
  for (let i = 0; i < sampleCount; i++) {
    const stockCode = mixedStocks[i];
    const rows = byStock.get(stockCode)!;
    console.log(`\n  [${stockCode}]`);
    for (const row of rows) {
      const netIncomeEok = row.net_income_parent !== null ? (row.net_income_parent / 1e8).toFixed(1) : "null";
      const equityEok = row.equity_parent !== null ? (row.equity_parent / 1e8).toFixed(1) : "null";
      console.log(`    FY${row.fiscal_year} (${row.fs_div}): 순이익 ${netIncomeEok}억, 자본총계 ${equityEok}억`);
    }
    // 인접 연도 간 fs_div가 바뀐 지점에서 변화율을 계산해 눈으로 확인할 수 있게 한다.
    for (let j = 1; j < rows.length; j++) {
      const prev = rows[j - 1];
      const curr = rows[j];
      if (prev.fs_div === curr.fs_div) continue;
      if (prev.net_income_parent && curr.net_income_parent && prev.net_income_parent !== 0) {
        const changePct = ((curr.net_income_parent - prev.net_income_parent) / Math.abs(prev.net_income_parent)) * 100;
        console.log(
          `    -> FY${prev.fiscal_year}(${prev.fs_div})→FY${curr.fiscal_year}(${curr.fs_div}) 순이익 변화: ${changePct.toFixed(1)}%`
        );
      }
      if (prev.equity_parent && curr.equity_parent && prev.equity_parent !== 0) {
        const changePct = ((curr.equity_parent - prev.equity_parent) / Math.abs(prev.equity_parent)) * 100;
        console.log(
          `    -> FY${prev.fiscal_year}(${prev.fs_div})→FY${curr.fiscal_year}(${curr.fs_div}) 자본총계 변화: ${changePct.toFixed(1)}%`
        );
      }
    }
  }

  console.log("\n########## 2. OFS만 있는 종목의 연도 커버리지 ##########");
  const ofsYearCounts = ofsOnlyStocks.map((s) => byStock.get(s)!.length);
  const avgYears = ofsYearCounts.length > 0 ? ofsYearCounts.reduce((a, b) => a + b, 0) / ofsYearCounts.length : 0;
  console.log(`  OFS만 있는 종목 ${ofsOnlyStocks.length}개, 평균 보유 연도 수: ${avgYears.toFixed(1)}년`);
  console.log(`  (정의상 전 연도 일관되게 OFS — 혼재 종목과는 별도 집합이라 자동으로 일관됨)`);
  console.log(`  표본 5개: ${ofsOnlyStocks.slice(0, 5).map((s) => `${s}(${byStock.get(s)!.length}년)`).join(", ")}`);

  console.log("\n=== 확인 종료 ===");
}

main().catch((error) => {
  console.error("확인 중 오류:", error);
  process.exit(1);
});
