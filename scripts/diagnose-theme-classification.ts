/**
 * (1회성, 읽기 전용) 테마별 구성종목 분류 검증용 진단 스크립트. DB/코드를 건드리지
 * 않는다 — KIS 종목마스터를 그대로 읽어 테마별 구성종목 전체 목록(코드/이름/
 * 종목구분코드)을 출력하고, 흔한 오분류 패턴(ETF/ETN/리츠/스팩, 우선주, 지주회사)을
 * 이름/종목구분코드 기준으로 표시만 한다 — 실제 필터링은 하지 않는다.
 *
 * 사용자 요청(테마 화면 구성종목 오분류 의심 검증)에 따라 실제 KIS 종목마스터 파일로
 * 확인한다. 확인 끝나면 삭제한다.
 *
 * server-only로 막힌 lib/stockMaster.ts를 순수 Node 스크립트에서도 재사용하려면
 * "react-server" 조건으로 실행해야 한다:
 *   tsx --conditions=react-server scripts/diagnose-theme-classification.ts
 */

import { getAllStocks } from "@/lib/stockMaster";
import { THEME_CODES, THEME_LABELS } from "@/lib/themeConfig";

const EXCLUDED_PRODUCT_TYPES = new Set(["RT", "EF", "EN"]); // 리츠/ETF/ETN (screen-all-stocks.ts와 동일)
const SPAC_SUBSTRINGS = ["스팩"];
// 국내 우선주 종목명 흔한 접미사 패턴: "OO우", "OO우B", "OO2우", "OO2우B" 등.
const PREFERRED_STOCK_PATTERN = /(\d?우[A-Z]?)$/;
const HOLDING_COMPANY_SUBSTRINGS = ["홀딩스", "지주"];

async function main(): Promise<void> {
  const allStocks = await getAllStocks();
  console.log(`전체 종목 수: ${allStocks.length}`);

  const productTypeCounts = new Map<string, number>();
  for (const s of allStocks) {
    productTypeCounts.set(s.productType, (productTypeCounts.get(s.productType) ?? 0) + 1);
  }
  console.log("종목구분코드 분포:", Object.fromEntries(productTypeCounts));

  for (const themeCode of THEME_CODES) {
    const members = allStocks.filter((s) => s.themeFlags[themeCode]);
    console.log(`\n===== ${THEME_LABELS[themeCode]}(${themeCode}) — ${members.length}종목 =====`);

    for (const s of members) {
      const flags: string[] = [];
      if (EXCLUDED_PRODUCT_TYPES.has(s.productType)) flags.push(`ETF/ETN/리츠(${s.productType})`);
      if (SPAC_SUBSTRINGS.some((kw) => s.name.includes(kw))) flags.push("스팩의심");
      if (PREFERRED_STOCK_PATTERN.test(s.name)) flags.push("우선주의심");
      if (HOLDING_COMPANY_SUBSTRINGS.some((kw) => s.name.includes(kw))) flags.push("지주회사의심");

      const flagLabel = flags.length > 0 ? `  <-- ${flags.join(", ")}` : "";
      console.log(`  ${s.code} ${s.name} [${s.productType}]${flagLabel}`);
    }
  }

  console.log("\n===== 요약 =====");
  for (const themeCode of THEME_CODES) {
    const members = allStocks.filter((s) => s.themeFlags[themeCode]);
    const etfEtc = members.filter((s) => EXCLUDED_PRODUCT_TYPES.has(s.productType));
    const spac = members.filter((s) => SPAC_SUBSTRINGS.some((kw) => s.name.includes(kw)));
    const preferred = members.filter((s) => PREFERRED_STOCK_PATTERN.test(s.name));
    const holding = members.filter((s) => HOLDING_COMPANY_SUBSTRINGS.some((kw) => s.name.includes(kw)));
    console.log(
      `${THEME_LABELS[themeCode]}: 전체 ${members.length} / ETF·ETN·리츠 ${etfEtc.length} / ` +
        `스팩의심 ${spac.length} / 우선주의심 ${preferred.length} / 지주회사의심 ${holding.length}`
    );
  }
}

main().catch((error) => {
  console.error("진단 중 오류:", error);
  process.exit(1);
});
