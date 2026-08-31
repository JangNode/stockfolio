/**
 * (1회성, 읽기 전용) 테마 기간별(월별/년별) 등락률 계산이 백필된 과거 시세로 실제
 * 정상 동작하는지 확인한다. scripts/backfill-theme-stock-prices.ts가 성공적으로
 * 끝난 것과, 그 데이터로 lib/themeReturns.ts의 계산 로직이 실제로 값을 만들어내는
 * 것은 별개라 별도로 확인한다. DB에 쓰지 않는다 — 확인 끝나면 삭제.
 *
 * app/api/themes/route.ts의 fetchComputedThemeRankings와 동일한 방식(과거 기간용
 * 경로)으로, 임의의 과거 월/년에 대해 몇 개 테마의 등락률을 실제로 계산해 출력한다.
 *
 * server-only로 막힌 lib/stockMaster.ts, lib/themeReturns.ts를 순수 Node
 * 스크립트에서도 재사용하려면 "react-server" 조건으로 실행해야 한다:
 *   tsx --conditions=react-server scripts/verify-theme-history-computation.ts
 */

import { getStockCodesByTheme } from "@/lib/stockMaster";
import { THEME_LABELS, type ThemeCode } from "@/lib/themeConfig";
import {
  averageReturnPct,
  computeStockReturnsForPeriod,
  isThemePeriodRangeAvailable,
  resolveThemePeriodRange,
  themeDataMinDate,
  type ThemePeriod,
} from "@/lib/themeReturns";

const SAMPLE_THEMES: ThemeCode[] = ["krx_semiconductor", "krx_bank"];

function todayKstIsoDate(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

async function checkPeriod(
  label: string,
  period: ThemePeriod,
  params: { date?: string; year?: string; month?: string },
  codesByTheme: Record<ThemeCode, string[]>
): Promise<void> {
  const today = todayKstIsoDate();
  const range = resolveThemePeriodRange(period, params, today);
  const available = isThemePeriodRangeAvailable(range, today);

  console.log(`\n=== ${label} (${period}, ${JSON.stringify(params)}) ===`);
  console.log(`  periodStartDate=${range.periodStartDate}, referenceEndDate=${range.referenceEndDate}`);
  console.log(`  themeDataMinDate=${themeDataMinDate(today)}, 범위 안=${available}`);

  if (!available) {
    console.log("  -> 범위 밖이라 계산을 시도하지 않음(insufficientData로 처리돼야 함)");
    return;
  }

  for (const themeCode of SAMPLE_THEMES) {
    const codes = codesByTheme[themeCode];
    const returns = await computeStockReturnsForPeriod(codes, range);
    const avg = averageReturnPct(returns);
    console.log(
      `  ${THEME_LABELS[themeCode]}: 구성종목 ${codes.length}개 중 계산됨 ${returns.size}개, ` +
        `평균 등락률 ${avg === null ? "null(데이터 없음)" : `${avg.toFixed(2)}%`}`
    );
  }
}

async function main(): Promise<void> {
  const codesByTheme = await getStockCodesByTheme();
  const today = todayKstIsoDate();
  const [todayYear, todayMonth] = today.split("-");

  const lastMonthDate = new Date(Date.UTC(Number(todayYear), Number(todayMonth) - 2, 1));
  const lastMonthYear = String(lastMonthDate.getUTCFullYear());
  const lastMonthMonth = String(lastMonthDate.getUTCMonth() + 1).padStart(2, "0");

  await checkPeriod("지난달", "monthly", { year: lastMonthYear, month: lastMonthMonth }, codesByTheme);
  await checkPeriod("작년(2025)", "yearly", { year: "2025" }, codesByTheme);
  await checkPeriod("범위 밖(2020)", "yearly", { year: "2020" }, codesByTheme);

  console.log("\n검증 완료.");
}

main().catch((error) => {
  console.error("검증 중 오류:", error);
  process.exit(1);
});
