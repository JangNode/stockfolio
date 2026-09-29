/**
 * [디스포저블 진단, 조사 끝나면 정리 PR로 제거] lib/kis.ts의 getOverseasDailyPrices
 * MODP=0→1 수정(fix/overseas-adjusted-price-modp) 후, 실제 함수를 그대로 호출해
 * 분할 종목(엔비디아)의 분할 전후 구간이 연속적으로(수정주가 기준) 나오는지
 * 재확인한다(2026-09-29). getOverseasDailyPrices는 항상 "오늘"부터 과거로만
 * 페이지네이션하고(OVERSEAS_MAX_CHART_PAGES=8 x 100행 = 최대 800행 ≈ 영업일 기준
 * 약 3.2년) 임의 기준일을 지정할 수 없어, 6년 전인 애플/테슬라(2020-08-31)
 * 분할은 이 함수로 재현 조회가 불가능하다(수정 전 낮은 레벨 재검증
 * diagnose-overseas-adjusted-price-verify.ts에서 이미 충분히 확인함) — 2년 전인
 * 엔비디아(2024-06-10 10:1 분할)만 실제 함수로 재확인한다.
 *
 * 실행: tsx --conditions=react-server scripts/diagnose-overseas-adjusted-price-postfix-verify.ts
 * 필요 환경변수: KIS_APP_KEY, KIS_APP_SECRET, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { getOverseasDailyPrices } from "@/lib/kis";

async function check(
  label: string,
  excd: "NAS" | "NYS" | "AMS",
  symb: string,
  targetRows: number,
  splitWindowFrom: string,
  splitWindowTo: string
): Promise<void> {
  console.log(`\n=== ${label} (EXCD=${excd}, SYMB=${symb}) — 수정 후 getOverseasDailyPrices 실호출 ===`);
  const prices = await getOverseasDailyPrices(excd, symb, "D", targetRows, "batch");
  console.log(`  총 ${prices.length}행(과거→최신), 첫 행=${prices[0]?.date}, 마지막 행=${prices[prices.length - 1]?.date}`);
  console.log(`  분할일 전후(${splitWindowFrom} ~ ${splitWindowTo})만 출력:`);
  for (const p of prices) {
    if (p.date < splitWindowFrom || p.date > splitWindowTo) continue;
    console.log(`    ${p.date}: 종가=${p.close} 시가=${p.open} 거래량=${p.volume.toLocaleString()}`);
  }
}

async function main(): Promise<void> {
  console.log(`해외 수정주가(MODP) 수정 후 재확인 시작: ${new Date().toISOString()}`);
  await check("엔비디아(NVDA) 2024-06-10 10:1 분할", "NAS", "NVDA", 700, "2024-05-15", "2024-06-25");
  console.log("\n완료");
}

main().catch((error) => {
  console.error("해외 수정주가(MODP) 수정 후 재확인 중 오류:", error);
  process.exit(1);
});
