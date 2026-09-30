/**
 * [디스포저블 진단 스크립트] hot table(stock_daily_prices_recent) 재시딩 전 확인.
 * 쓰기 없음(순수 조회) — upsertRecentPrices를 호출하지 않는다.
 *
 * 1. 재시딩 dry-run: 넓어진 parquet의 hot 구간(최근 STOCK_DATA_HOT_WINDOW_YEARS년)
 *    행 중, 이미 stock_daily_prices_recent에 있는 (종목,날짜) 키를 빼고 실제로
 *    추가될 신규 행 수를 계산한다.
 * 2. strategy_backtest_summary/benchmark_summary 최신 행 시각을 확인해 화면이
 *    지금 어떤 계산 시점의 수치를 보여주고 있는지 확인한다.
 * 3. 2023~2026년 ±30% 초과 일간 변동을 월별로 집계해 2026년이 유독 많은 이유를
 *    조사한다(수정 없음, 집계만).
 *
 * 실행: npm run diagnose:hot-table-reseed-impact
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { downloadYearPrices, hotWindowStartDate } from "@/lib/stockDailyPricesStorage";

const HOT_TABLE = "stock_daily_prices_recent";
const PAGE_SIZE = 1000;

async function dryRunReseedImpact(): Promise<void> {
  console.log("=== 1. 재시딩 dry-run (쓰기 없음) ===");
  const cutoff = hotWindowStartDate();
  const cutoffYear = Number(cutoff.slice(0, 4));
  const currentYear = new Date().getUTCFullYear();
  console.log(`hot 구간 시작일: ${cutoff}`);

  const parquetKeys = new Set<string>();
  for (let year = cutoffYear; year <= currentYear; year++) {
    const rows = await downloadYearPrices(year);
    const inWindow = rows.filter((r) => r.tradeDate >= cutoff);
    for (const r of inWindow) parquetKeys.add(`${r.stockCode}:${r.tradeDate}`);
    console.log(`  ${year}년 parquet: 전체 ${rows.length}행 중 hot 구간 ${inWindow.length}행`);
  }
  console.log(`parquet 기준 hot 구간 총 (종목,날짜) 키: ${parquetKeys.size}개`);

  let existingCount = 0;
  let from = 0;
  for (;;) {
    const { data, error } = await supabaseAdmin
      .from(HOT_TABLE)
      .select("stock_code, trade_date")
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`hot table 조회 실패: ${error.message}`);
    for (const row of data ?? []) {
      const key = `${(row as { stock_code: string }).stock_code}:${(row as { trade_date: string }).trade_date}`;
      parquetKeys.delete(key);
    }
    existingCount += data?.length ?? 0;
    if (!data || data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  console.log(`hot table 현재 실제 행 수(조회 기준): ${existingCount}행`);
  console.log(`재시딩 시 새로 추가될 행 수(parquet에 있는데 hot table에 없는 키): ${parquetKeys.size}행`);
}

async function checkBacktestSummaryFreshness(): Promise<void> {
  console.log("\n=== 2. strategy_backtest_summary / benchmark_summary 최신 상태 ===");
  const { data: stratRows, error: stratError } = await supabaseAdmin
    .from("strategy_backtest_summary")
    .select("rule_type, market, computed_at, cagr_pct, mdd_pct")
    .order("computed_at", { ascending: false })
    .limit(20);
  if (stratError) throw new Error(`strategy_backtest_summary 조회 실패: ${stratError.message}`);
  const seen = new Set<string>();
  for (const row of stratRows ?? []) {
    const r = row as { rule_type: string; market: string; computed_at: string; cagr_pct: number | null; mdd_pct: number | null };
    const key = `${r.rule_type}:${r.market}`;
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(`  [${key}] computed_at=${r.computed_at}, CAGR=${r.cagr_pct}%, MDD=${r.mdd_pct}% — 화면에 노출되는 최신 값`);
  }

  const { data: benchRows, error: benchError } = await supabaseAdmin
    .from("benchmark_summary")
    .select("benchmark_type, computed_at, cagr_pct, mdd_pct")
    .order("computed_at", { ascending: false })
    .limit(10);
  if (benchError) throw new Error(`benchmark_summary 조회 실패: ${benchError.message}`);
  const seenBench = new Set<string>();
  for (const row of benchRows ?? []) {
    const r = row as { benchmark_type: string; computed_at: string; cagr_pct: number; mdd_pct: number };
    if (seenBench.has(r.benchmark_type)) continue;
    seenBench.add(r.benchmark_type);
    console.log(`  [${r.benchmark_type}] computed_at=${r.computed_at}, CAGR=${r.cagr_pct}%, MDD=${r.mdd_pct}%`);
  }
}

async function monthlyBigSwingBreakdown(years: number[]): Promise<void> {
  console.log("\n=== 3. ±30% 초과 일간 변동 월별 분포 ===");
  for (const year of years) {
    const rows = await downloadYearPrices(year);
    const byCode = new Map<string, { tradeDate: string; closePrice: number }[]>();
    for (const r of rows) {
      const arr = byCode.get(r.stockCode);
      if (arr) arr.push({ tradeDate: r.tradeDate, closePrice: r.closePrice });
      else byCode.set(r.stockCode, [{ tradeDate: r.tradeDate, closePrice: r.closePrice }]);
    }
    const monthlyCounts = new Map<string, number>();
    const monthlyTradingDays = new Map<string, Set<string>>();
    for (const r of rows) {
      const month = r.tradeDate.slice(0, 7);
      const set = monthlyTradingDays.get(month) ?? new Set<string>();
      set.add(r.tradeDate);
      monthlyTradingDays.set(month, set);
    }
    for (const codeRows of byCode.values()) {
      codeRows.sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
      for (let i = 1; i < codeRows.length; i++) {
        const prev = codeRows[i - 1].closePrice;
        const cur = codeRows[i].closePrice;
        if (!prev || !Number.isFinite(prev) || !Number.isFinite(cur)) continue;
        const changePct = Math.abs((cur - prev) / prev) * 100;
        if (changePct >= 30) {
          const month = codeRows[i].tradeDate.slice(0, 7);
          monthlyCounts.set(month, (monthlyCounts.get(month) ?? 0) + 1);
        }
      }
    }
    console.log(`\n[${year}년]`);
    const months = Array.from(monthlyTradingDays.keys()).sort();
    for (const month of months) {
      const count = monthlyCounts.get(month) ?? 0;
      const tradingDays = monthlyTradingDays.get(month)?.size ?? 0;
      console.log(`  ${month}: ${count}건 (거래일 ${tradingDays}일, 거래일당 ${(count / tradingDays).toFixed(2)}건)`);
    }
  }
}

async function main(): Promise<void> {
  await dryRunReseedImpact();
  await checkBacktestSummaryFreshness();
  await monthlyBigSwingBreakdown([2023, 2024, 2025, 2026]);
}

main().catch((error) => {
  console.error("진단 중 오류:", error);
  process.exit(1);
});
