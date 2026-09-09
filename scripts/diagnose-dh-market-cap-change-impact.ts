/**
 * (임시) DH전략 시총 기준 1조원→2조원 변경 후, 오늘 기준 실제로 몇 종목이 걸리는지
 * 확인한다. 프로덕션 로직(scripts/screen-all-stocks.ts의 scanFundamentalStrategies가
 * matchesToday를 거쳐 호출하는 computeDhValueDividendStates, lib/backtest.ts)과
 * 동일한 point-in-time 판정을 재사용하되, DB에는 아무것도 쓰지 않고 콘솔에만 집계한다.
 * 새 기준(2조, lib/dhStrategyConfig.ts에 이미 반영됨)과 이전 기준(1조)을 나란히
 * 비교한다.
 *
 * 읽기 전용. 확인 후 즉시 삭제 예정.
 * tsx --conditions=react-server scripts/diagnose-dh-market-cap-change-impact.ts
 */
import { discoverCandidateStockCodes, getDailyPriceOnOrBefore } from "@/lib/stockDailyPricesStorage";
import { loadFundamentalsSeries } from "@/lib/stockFundamentals";
import { pickFundamentalsAsOf, pickDividendsPaidAsOf, computeValuationFromSeries } from "@/lib/pointInTimeFundamentals";
import { evaluateConsecutiveDividendYears } from "@/lib/backtest";
import { DH_MAX_PER, DH_MAX_PBR, DH_MIN_CONSECUTIVE_DIVIDEND_YEARS } from "@/lib/dhStrategyConfig";
import { STOCK_DATA_CANDIDATE_MARKET_CAP_EOK } from "@/lib/stockDataConfig";

const OLD_MIN_MARKET_CAP_EOK = 10_000; // 변경 전(1조원)
const NEW_MIN_MARKET_CAP_EOK = 20_000; // 변경 후(2조원, lib/dhStrategyConfig.ts와 동일)
const FUNDAMENTAL_CANDIDATE_START_YEAR = 2011;

function todayKstDate(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

async function main(): Promise<void> {
  const today = todayKstDate();
  console.log(`########## DH전략 시총 기준 변경 영향 확인 (기준일 ${today}) ##########\n`);

  const currentYear = new Date().getUTCFullYear();
  const years = Array.from(
    { length: currentYear - FUNDAMENTAL_CANDIDATE_START_YEAR + 1 },
    (_, i) => FUNDAMENTAL_CANDIDATE_START_YEAR + i
  );
  const candidates = await discoverCandidateStockCodes(years, STOCK_DATA_CANDIDATE_MARKET_CAP_EOK);
  console.log(`후보종목 ${candidates.length}개`);
  console.log(
    `(주의: 프로덕션 스캔은 이 목록에 마스터 필터(스팩/리츠·ETF·ETN/신규상장/상장폐지위험 제외)를 추가로 적용한다 — 아래 집계는 그 필터 전 숫자라 실제 운영 결과보다 같거나 많을 수 있음)\n`
  );

  let oldMatched = 0;
  let newMatched = 0;
  const oldOnly: string[] = [];
  const bothMatched: string[] = [];

  for (const code of candidates) {
    const [priceRow, fundamentals] = await Promise.all([
      getDailyPriceOnOrBefore(code, today),
      loadFundamentalsSeries(code),
    ]);
    if (!priceRow) continue;

    const fund = pickFundamentalsAsOf(fundamentals, today);
    if (!fund) continue;
    const { per, pbr } = computeValuationFromSeries(priceRow.closePrice, priceRow.listedShares, fund);
    if (per === null || per > DH_MAX_PER) continue;
    if (pbr === null || pbr > DH_MAX_PBR) continue;
    const dividends = pickDividendsPaidAsOf(fundamentals, today);
    const { consecutiveOk } = evaluateConsecutiveDividendYears(dividends, today, DH_MIN_CONSECUTIVE_DIVIDEND_YEARS);
    if (!consecutiveOk) continue;

    // 여기까지 왔으면 시총 조건만 남음(PER/PBR/배당은 신구 공통 조건).
    const passesOld = priceRow.marketCapEok >= OLD_MIN_MARKET_CAP_EOK;
    const passesNew = priceRow.marketCapEok >= NEW_MIN_MARKET_CAP_EOK;
    if (passesOld) oldMatched++;
    if (passesNew) newMatched++;
    if (passesOld && !passesNew) oldOnly.push(`${code}(${priceRow.marketCapEok.toFixed(0)}억)`);
    if (passesNew) bothMatched.push(`${code}(${priceRow.marketCapEok.toFixed(0)}억)`);
  }

  console.log(`########## 결과 ##########`);
  console.log(`기존 기준(1조원) 매칭: ${oldMatched}개`);
  console.log(`새 기준(2조원) 매칭: ${newMatched}개`);
  console.log(`\n2조원 미만이라 새로 제외된 종목(${oldOnly.length}개): ${oldOnly.join(", ") || "없음"}`);
  console.log(`\n새 기준으로도 매칭되는 종목(${bothMatched.length}개): ${bothMatched.join(", ") || "없음"}`);
  console.log("\n=== 확인 종료 ===");
}

main().catch((error) => {
  console.error("확인 중 오류:", error);
  process.exit(1);
});
