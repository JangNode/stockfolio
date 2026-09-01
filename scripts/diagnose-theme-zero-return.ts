/**
 * (임시) 테마 화면 등락률이 특정 과거 날짜에 전부 0.00%로 나오는 문제를 실데이터로
 * 조사한다. DB에는 아무것도 쓰지 않는 읽기 전용 진단 — 확인 끝나면 정리 PR에서
 * 스크립트/워크플로와 함께 삭제한다.
 *
 * 가설: stock_daily_prices_recent(hot 테이블)는 scripts/update-stock-daily-prices-recent.ts가
 * KRX 정산 데이터로 채우는데, 이 배치가 "오늘"을 뺀 "어제까지"만 채운다(당일 KRX
 * 정산 데이터가 아직 확정 전이라서). 그래서 어떤 날짜 D를 조회할 때 그 다음날 배치가
 * 아직 안 돌았으면 stock_daily_prices_recent에 D의 행이 없고,
 * getDailyPricesForStocksOnOrBefore가 조용히 D 이전 날짜로 폴백한다. lib/themeReturns.ts의
 * computeStockReturnsForPeriod는 daily 기간에서 baseline=D-1, end=D를 조회하는데, D의
 * 행이 없으면 end도 D-1로 폴백돼 baseline과 end가 같은 값이 되어 등락률이 0%로
 * 계산된다(실제로는 "데이터 없음"이어야 함).
 *
 * 확인 순서:
 * 1) theme_daily_returns의 2026-09-01자 12개 행(그날 "오늘"이었을 때 KIS 원값 경로로
 *    저장된 집계값) — change_rate_pct/constituent_count 그대로 출력
 * 2) 반도체(krx_semiconductor) 테마 구성종목 전체의 2026-09-01자 개별 등락률
 *    (theme_daily_returns.constituents jsonb에서) 나열
 * 3) 그중 일부 종목의 stock_daily_prices_recent 최근 며칠(2026-08-28~09-02) 행 존재
 *    여부와 close_price를 그대로 출력 — 9/1 행이 실제로 있는지, 8/31과 값이 같은지
 * 4) lib/themeReturns.ts를 그대로 호출해 "지금 이 순간" period=daily date=2026-09-01로
 *    API가 실제로 계산해 낼 값을 재현
 *
 * 필요 환경변수: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   tsx --conditions=react-server scripts/diagnose-theme-zero-return.ts
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getStockCodesByTheme } from "@/lib/stockMaster";
import { THEME_LABELS, type ThemeCode } from "@/lib/themeConfig";
import {
  averageReturnPct,
  computeStockReturnsForPeriod,
  resolveThemePeriodRange,
} from "@/lib/themeReturns";

const TARGET_DATE = "2026-09-01";

function todayKstIsoDate(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined) return "null";
  return n.toLocaleString("ko-KR", { maximumFractionDigits: 6 });
}

interface ThemeDailyReturnRow {
  theme_code: string;
  change_rate_pct: number;
  constituent_count: number;
  up_count: number;
  down_count: number;
  constituents: { code: string; name: string; changeRate: number }[];
}

async function main(): Promise<void> {
  const today = todayKstIsoDate();
  console.log(`=== 테마 등락률 0.00% 버그 조사 (지금 서버 기준 오늘 KST: ${today}, 조사 대상 날짜: ${TARGET_DATE}) ===\n`);

  console.log("--- 1) theme_daily_returns (2026-09-01자, KIS 원값 경로로 저장된 값) ---");
  const { data: rows, error } = await supabaseAdmin
    .from("theme_daily_returns")
    .select("theme_code, change_rate_pct, constituent_count, up_count, down_count, constituents")
    .eq("trade_date", TARGET_DATE);
  if (error) throw new Error(`theme_daily_returns 조회 실패: ${error.message}`);
  const typedRows = (rows ?? []) as ThemeDailyReturnRow[];
  for (const r of typedRows) {
    console.log(
      `  ${THEME_LABELS[r.theme_code as ThemeCode] ?? r.theme_code}(${r.theme_code}): ` +
        `change_rate_pct=${fmt(r.change_rate_pct)} constituent_count=${r.constituent_count} ` +
        `up=${r.up_count} down=${r.down_count} constituents.length=${r.constituents?.length ?? 0}`
    );
  }
  if (typedRows.length === 0) console.log("  (행 없음)");

  console.log("\n--- 2) 반도체(krx_semiconductor) 구성종목 개별 등락률 (theme_daily_returns.constituents, 2026-09-01자) ---");
  const semiRow = typedRows.find((r) => r.theme_code === "krx_semiconductor");
  if (!semiRow || !semiRow.constituents || semiRow.constituents.length === 0) {
    console.log("  구성종목 상세가 비어있습니다(3년 지나 비워졌거나 애초에 저장 안 됨).");
  } else {
    console.log(`  총 ${semiRow.constituents.length}종목:`);
    for (const c of semiRow.constituents) {
      console.log(`    ${c.name}(${c.code}): changeRate=${fmt(c.changeRate)}%`);
    }
    const nonZero = semiRow.constituents.filter((c) => c.changeRate !== 0);
    console.log(`  → 0이 아닌 종목 수: ${nonZero.length}/${semiRow.constituents.length}`);
  }

  console.log("\n--- 3) stock_daily_prices_recent 실제 저장 행 (반도체 구성종목 중 최대 5개 샘플, 2026-08-28~09-02) ---");
  const sampleCodes = (semiRow?.constituents ?? []).slice(0, 5).map((c) => c.code);
  if (sampleCodes.length === 0) {
    console.log("  샘플 종목이 없어 건너뜁니다.");
  } else {
    const { data: priceRows, error: priceError } = await supabaseAdmin
      .from("stock_daily_prices_recent")
      .select("stock_code, trade_date, close_price")
      .in("stock_code", sampleCodes)
      .gte("trade_date", "2026-08-28")
      .lte("trade_date", "2026-09-02")
      .order("stock_code", { ascending: true })
      .order("trade_date", { ascending: true });
    if (priceError) throw new Error(`stock_daily_prices_recent 조회 실패: ${priceError.message}`);
    const byCode = new Map<string, { trade_date: string; close_price: number }[]>();
    for (const row of priceRows ?? []) {
      const list = byCode.get(row.stock_code as string) ?? [];
      list.push({ trade_date: row.trade_date as string, close_price: row.close_price as number });
      byCode.set(row.stock_code as string, list);
    }
    for (const code of sampleCodes) {
      const name = semiRow?.constituents.find((c) => c.code === code)?.name ?? code;
      console.log(`  ${name}(${code}):`);
      const list = byCode.get(code) ?? [];
      if (list.length === 0) {
        console.log("    (2026-08-28~09-02 구간에 저장된 행 없음)");
        continue;
      }
      for (const p of list) {
        console.log(`    ${p.trade_date}: close_price=${fmt(p.close_price)}`);
      }
      const has0901 = list.some((p) => p.trade_date === TARGET_DATE);
      const has0831 = list.some((p) => p.trade_date === "2026-08-31");
      console.log(`    → 2026-09-01 행 존재? ${has0901} / 2026-08-31 행 존재? ${has0831}`);
      if (has0901 && has0831) {
        const c0901 = list.find((p) => p.trade_date === TARGET_DATE)!.close_price;
        const c0831 = list.find((p) => p.trade_date === "2026-08-31")!.close_price;
        console.log(`    → 09-01 close == 08-31 close? ${c0901 === c0831} (${fmt(c0901)} vs ${fmt(c0831)})`);
      }
    }
  }

  console.log(`\n--- 4) lib/themeReturns.ts 실제 재현: period=daily date=${TARGET_DATE} (지금 이 순간 API가 계산할 값) ---`);
  const range = resolveThemePeriodRange("daily", { date: TARGET_DATE }, today);
  console.log(`  resolveThemePeriodRange 결과: periodStartDate=${range.periodStartDate} referenceEndDate=${range.referenceEndDate} isToday=${range.isToday}`);
  if (range.isToday) {
    console.log("  isToday=true → API는 theme_daily_returns(위 1번 결과)를 그대로 씁니다. 재계산 경로를 타지 않습니다.");
  } else {
    const codesByTheme = await getStockCodesByTheme();
    const semiCodes = codesByTheme.krx_semiconductor;
    console.log(`  종목마스터 기준 반도체 구성종목 수(오늘 기준 근사): ${semiCodes.length}`);
    const returns = await computeStockReturnsForPeriod(semiCodes, range);
    console.log(`  computeStockReturnsForPeriod 결과: ${returns.size}/${semiCodes.length}종목에서 값 계산됨`);
    const sample = Array.from(returns.entries()).slice(0, 10);
    for (const [code, pct] of sample) {
      console.log(`    ${code}: ${fmt(pct)}%`);
    }
    const avg = averageReturnPct(returns);
    console.log(`  반도체 테마 평균 등락률(재계산) = ${fmt(avg)}%`);
    const allZero = Array.from(returns.values()).every((v) => v === 0);
    console.log(`  → 모든 값이 정확히 0? ${allZero}`);
  }

  console.log("\n=== 조사 종료 ===");
}

main().catch((error) => {
  console.error("진단 스크립트 실행 중 오류:", error);
  process.exit(1);
});
