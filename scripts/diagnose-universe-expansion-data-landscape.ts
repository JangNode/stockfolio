/**
 * [디스포저블 진단, 조사 끝나면 정리 PR로 제거] 백테스트 유니버스를 "시총 무관 전
 * 종목(상장폐지 포함), 시점별 편입"으로 넓히는 방안 조사(2026-09-29, PR-3와 무관한
 * 별도 조사)의 1단계 — 현재 저장된 시세 원자료의 실제 규모/공백을 실측한다.
 * DB에는 아무것도 쓰지 않는다(순수 조회+계산+콘솔 출력).
 *
 * 실행: tsx --conditions=react-server scripts/diagnose-universe-expansion-data-landscape.ts
 * 필요 환경변수: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { downloadYearPrices, type StockDailyPriceRow } from "@/lib/stockDailyPricesStorage";
import { getAllStocks } from "@/lib/stockMaster";
import { getDelistedStockCodes } from "@/lib/delistedStockList";
import { STOCK_DATA_CANDIDATE_MARKET_CAP_EOK, STOCK_DATA_BACKFILL_MARKET_CAP_FLOOR_EOK } from "@/lib/stockDataConfig";

const HOT_TABLE = "stock_daily_prices_recent";
const HOT_TABLE_PAGE_SIZE = 1000;
const START_YEAR = 2011;
const CURRENT_YEAR = new Date().getUTCFullYear();
// screen-all-stocks.ts와 동일한 잡주 제외 기준(리츠/ETF/ETN) — "실질 보통주" 기준으로
// getAllStocks()를 걸러야 공정한 diff가 된다.
const EXCLUDED_PRODUCT_TYPES = new Set(["RT", "EF", "EN"]);
const EXCLUDED_NAME_SUBSTRINGS = ["스팩"];

interface HotRow {
  stock_code: string;
  trade_date: string;
  close_price: number;
  listed_shares: number;
  volume: number;
}

async function fetchHotRowsInRange(startDate: string, endDate: string): Promise<HotRow[]> {
  const rows: HotRow[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabaseAdmin
      .from(HOT_TABLE)
      .select("stock_code, trade_date, close_price, listed_shares, volume")
      .gte("trade_date", startDate)
      .lte("trade_date", endDate)
      .range(from, from + HOT_TABLE_PAGE_SIZE - 1);
    if (error) throw new Error(`hot 구간 조회 실패(${startDate}~${endDate}): ${error.message}`);
    for (const row of data ?? []) rows.push(row as HotRow);
    if (!data || data.length < HOT_TABLE_PAGE_SIZE) break;
    from += HOT_TABLE_PAGE_SIZE;
  }
  return rows;
}

async function fetchHotRowsForCode(code: string): Promise<{ trade_date: string; close_price: number }[]> {
  const { data, error } = await supabaseAdmin
    .from(HOT_TABLE)
    .select("trade_date, close_price")
    .eq("stock_code", code)
    .order("trade_date", { ascending: true });
  if (error) throw new Error(`${code} hot 구간 조회 실패: ${error.message}`);
  return (data ?? []) as { trade_date: string; close_price: number }[];
}

async function main(): Promise<void> {
  console.log(`데이터 현황 조사 시작: ${new Date().toISOString()}`);
  console.log(
    `기준값: 후보 컷오프 ${STOCK_DATA_CANDIDATE_MARKET_CAP_EOK}억원, 백필 저장 하한 ${STOCK_DATA_BACKFILL_MARKET_CAP_FLOOR_EOK}억원`
  );

  // 1) 연도별 저장된 고유 종목 수 (cold parquet + hot 구간 합집합)
  console.log("\n=== 1) 연도별 저장된 고유 종목 수 (2011~오늘) ===");
  const allStoredCodes = new Set<string>();
  const perYearCounts: { year: number; count: number; rows: number }[] = [];
  let totalRows = 0;

  for (let year = START_YEAR; year <= CURRENT_YEAR; year++) {
    const yearCodes = new Set<string>();
    let yearRows = 0;

    const coldRows: StockDailyPriceRow[] = await downloadYearPrices(year);
    for (const r of coldRows) {
      yearCodes.add(r.stockCode);
      allStoredCodes.add(r.stockCode);
    }
    yearRows += coldRows.length;

    const hotRows = await fetchHotRowsInRange(`${year}-01-01`, `${year}-12-31`);
    for (const r of hotRows) {
      yearCodes.add(r.stock_code);
      allStoredCodes.add(r.stock_code);
    }
    yearRows += hotRows.length;

    perYearCounts.push({ year, count: yearCodes.size, rows: yearRows });
    totalRows += yearRows;
    console.log(`  ${year}년: 고유 종목 ${yearCodes.size}개, 행 ${yearRows}개 (cold ${coldRows.length} / hot ${hotRows.length})`);
  }

  console.log(`\n총 누적 고유 종목 수(2011~오늘 어느 해든 저장된 적 있음): ${allStoredCodes.size}개, 총 행 수: ${totalRows}개`);

  // 2) 현재 상장 종목 vs 저장된 종목 diff
  console.log("\n=== 2) 현재 상장 종목(getAllStocks) vs 저장된 종목 diff ===");
  const allStocks = await getAllStocks();
  const realStocks = allStocks.filter(
    (s) => !EXCLUDED_PRODUCT_TYPES.has(s.productType) && !EXCLUDED_NAME_SUBSTRINGS.some((sub) => s.name.includes(sub))
  );
  console.log(`getAllStocks() 전체: ${allStocks.length}개, 잡주(리츠/ETF/ETN/스팩) 제외 후: ${realStocks.length}개`);

  const missingCurrentlyListed = realStocks.filter((s) => !allStoredCodes.has(s.code));
  console.log(
    `현재 상장돼 있지만 시세가 전혀 없는 종목: ${missingCurrentlyListed.length}개 ` +
      `(${realStocks.length}개 중 ${((missingCurrentlyListed.length / realStocks.length) * 100).toFixed(1)}%)`
  );
  console.log(
    `  샘플 20개: ${missingCurrentlyListed
      .slice(0, 20)
      .map((s) => `${s.code}(${s.name})`)
      .join(", ")}`
  );
  const missingByMarket = { KOSPI: 0, KOSDAQ: 0 };
  for (const s of missingCurrentlyListed) missingByMarket[s.market]++;
  console.log(`  시장별: KOSPI ${missingByMarket.KOSPI}개, KOSDAQ ${missingByMarket.KOSDAQ}개`);
  const missingAdminIssue = missingCurrentlyListed.filter((s) => s.isAdministrativeIssue).length;
  console.log(`  이 중 오늘 기준 관리종목 지정: ${missingAdminIssue}개`);

  // 3) 상장폐지 종목 vs 저장된 종목 diff
  console.log("\n=== 3) 상장폐지 종목(getDelistedStockCodes) vs 저장된 종목 diff ===");
  const delistedCodes = await getDelistedStockCodes();
  console.log(`상장폐지 종목 목록: ${delistedCodes.size}개`);

  const delistedWithData = Array.from(delistedCodes).filter((c) => allStoredCodes.has(c));
  const delistedWithoutData = delistedCodes.size - delistedWithData.length;
  console.log(`  시세 있음: ${delistedWithData.length}개, 시세 없음: ${delistedWithoutData}개`);

  // 데이터 기간(첫날~마지막날) 분포 확인 — 표본 60개만 hot 구간 쿼리로 확인(전체
  // 726개를 다 개별 쿼리하면 시간이 오래 걸려 조사 목적에는 표본으로 충분).
  const SAMPLE_SIZE = 60;
  const sample = delistedWithData.slice(0, SAMPLE_SIZE);
  console.log(`  데이터 기간 표본 확인(${sample.length}개, hot 구간 쿼리 — cold 구간 종목은 아래 연도별 로그로 범위 추정):`);
  let sampleChecked = 0;
  for (const code of sample) {
    const hotRows = await fetchHotRowsForCode(code);
    if (hotRows.length > 0) {
      sampleChecked++;
      if (sampleChecked <= 10) {
        console.log(`    ${code}: hot 구간 ${hotRows[0].trade_date} ~ ${hotRows[hotRows.length - 1].trade_date} (${hotRows.length}행)`);
      }
    }
  }
  console.log(`  표본 중 hot 구간(최근 2년)에도 데이터가 있는 종목: ${sampleChecked}/${sample.length}개(나머지는 cold 구간에만 있거나 이미 오래전 상장폐지)`);

  // 4) 수정주가 여부 확인 — 삼성전자 2018-05-04 50:1 액면분할 전후 종가/상장주식수
  console.log("\n=== 4) 수정주가 여부 확인 (삼성전자 005930, 2018-05-04 50:1 액면분할) ===");
  const samsungRows2018 = await downloadYearPrices(2018);
  const samsungAround = samsungRows2018
    .filter((r) => r.stockCode === "005930" && r.tradeDate >= "2018-04-25" && r.tradeDate <= "2018-05-15")
    .sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
  if (samsungAround.length === 0) {
    console.log("  005930의 2018년 4~5월 데이터가 없습니다(시총 하한 미달 가능성 낮음 — 확인 필요).");
  } else {
    for (const r of samsungAround) {
      console.log(
        `    ${r.tradeDate}: 종가 ${r.closePrice.toLocaleString()}원, 시가총액 ${r.marketCapEok.toLocaleString()}억원, ` +
          `상장주식수 ${r.listedShares.toLocaleString()}주`
      );
    }
    console.log(
      "  → 분할일 전후로 종가가 약 50배 차이 나고 상장주식수가 약 50배로 늘었으면 KRX가 원가(비수정주가)를 그대로 준다는 뜻" +
        "(수정주가라면 분할 전 과거 종가도 이미 분할 반영돼 연속적으로 보여야 함)."
    );
  }

  // 5) 초소형주 vs 대형주 일별 변동성 비교(고가-저가 스프레드, ±30% 초과 일수)
  console.log("\n=== 5) 초소형주 vs 대형주 일별 변동성 비교 (최근 3년, 표본) ===");
  const recentStart = `${CURRENT_YEAR - 3}-01-01`;
  const recentRows2024 = await downloadYearPrices(CURRENT_YEAR - 2);
  const recentRows2025 = await downloadYearPrices(CURRENT_YEAR - 1);
  const hotRecent = await fetchHotRowsInRangeFull(recentStart, `${CURRENT_YEAR}-12-31`);

  const byCode = new Map<string, { tradeDate: string; close: number; high: number; low: number }[]>();
  function addRow(code: string, row: { tradeDate: string; close: number; high: number; low: number }): void {
    const list = byCode.get(code);
    if (list) list.push(row);
    else byCode.set(code, [row]);
  }
  for (const r of [...recentRows2024, ...recentRows2025]) {
    if (r.tradeDate >= recentStart) addRow(r.stockCode, { tradeDate: r.tradeDate, close: r.closePrice, high: r.highPrice, low: r.lowPrice });
  }
  for (const r of hotRecent) addRow(r.stock_code, { tradeDate: r.trade_date, close: r.close_price, high: r.high_price, low: r.low_price });

  // 종목별 최근 3년 평균 시총으로 대형(1조 이상) / 중소형(5천억~1조, 저장 하한
  // 예외로만 들어온 종목) 분류. 최근 데이터에 marketCapEok이 없으므로 hot 구간에서
  // 별도 조회.
  const marketCapByCode = await fetchAvgMarketCap(recentStart, `${CURRENT_YEAR}-12-31`);

  const large: string[] = [];
  const smallMid: string[] = [];
  for (const [code, avgCap] of marketCapByCode) {
    if (avgCap >= STOCK_DATA_CANDIDATE_MARKET_CAP_EOK) large.push(code);
    else if (avgCap >= 500) smallMid.push(code); // 500억 이상(초소형 노이즈 제외), 1조 미만
  }
  console.log(`  분류: 대형(1조원+) ${large.length}개, 중소형(500억~1조원, 예외로 저장됨) ${smallMid.length}개`);

  function sampleN<T>(arr: T[], n: number): T[] {
    const copy = [...arr];
    const out: T[] = [];
    while (out.length < n && copy.length > 0) {
      const idx = Math.floor(Math.random() * copy.length);
      out.push(copy.splice(idx, 1)[0]);
    }
    return out;
  }

  function computeStats(codes: string[]): { avgSpreadPct: number; extremeDayCount: number; totalDays: number } {
    let spreadSum = 0;
    let spreadCount = 0;
    let extremeDayCount = 0;
    let totalDays = 0;
    for (const code of codes) {
      const rows = (byCode.get(code) ?? []).sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (r.high > 0 && r.low > 0 && r.close > 0) {
          spreadSum += ((r.high - r.low) / r.close) * 100;
          spreadCount++;
        }
        if (i > 0) {
          const prevClose = rows[i - 1].close;
          if (prevClose > 0) {
            const retPct = ((r.close - prevClose) / prevClose) * 100;
            if (Math.abs(retPct) > 30) extremeDayCount++;
            totalDays++;
          }
        }
      }
    }
    return { avgSpreadPct: spreadCount > 0 ? spreadSum / spreadCount : 0, extremeDayCount, totalDays };
  }

  const largeSample = sampleN(large, Math.min(30, large.length));
  const smallMidSample = sampleN(smallMid, Math.min(30, smallMid.length));
  const largeStats = computeStats(largeSample);
  const smallMidStats = computeStats(smallMidSample);
  console.log(
    `  대형주 표본(${largeSample.length}개): 평균 고가-저가 스프레드 ${largeStats.avgSpreadPct.toFixed(2)}%, ` +
      `일별수익률 ±30% 초과 ${largeStats.extremeDayCount}건/${largeStats.totalDays}일`
  );
  console.log(
    `  중소형주 표본(${smallMidSample.length}개): 평균 고가-저가 스프레드 ${smallMidStats.avgSpreadPct.toFixed(2)}%, ` +
      `일별수익률 ±30% 초과 ${smallMidStats.extremeDayCount}건/${smallMidStats.totalDays}일`
  );

  // 6) 관리종목/투자주의 등 상태 플래그 확인(오늘 기준 스냅샷)
  console.log("\n=== 6) 관리종목/거래정지/정리매매 플래그 (오늘 기준 KIS 종목마스터, point-in-time 아님) ===");
  const adminCount = realStocks.filter((s) => s.isAdministrativeIssue).length;
  const haltedCount = realStocks.filter((s) => s.isTradingHalted).length;
  const liquidationCount = realStocks.filter((s) => s.isLiquidationTrading).length;
  console.log(`  관리종목 지정: ${adminCount}개, 거래정지: ${haltedCount}개, 정리매매: ${liquidationCount}개 (오늘 스냅샷만 가능, 과거 시점 이력 없음)`);

  console.log("\n완료");
}

async function fetchHotRowsInRangeFull(
  startDate: string,
  endDate: string
): Promise<{ stock_code: string; trade_date: string; close_price: number; high_price: number; low_price: number }[]> {
  const rows: { stock_code: string; trade_date: string; close_price: number; high_price: number; low_price: number }[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabaseAdmin
      .from(HOT_TABLE)
      .select("stock_code, trade_date, close_price, high_price, low_price")
      .gte("trade_date", startDate)
      .lte("trade_date", endDate)
      .range(from, from + HOT_TABLE_PAGE_SIZE - 1);
    if (error) throw new Error(`hot 구간(전체 컬럼) 조회 실패: ${error.message}`);
    for (const row of data ?? []) rows.push(row as (typeof rows)[number]);
    if (!data || data.length < HOT_TABLE_PAGE_SIZE) break;
    from += HOT_TABLE_PAGE_SIZE;
  }
  return rows;
}

async function fetchAvgMarketCap(startDate: string, endDate: string): Promise<Map<string, number>> {
  const sums = new Map<string, { sum: number; count: number }>();
  let from = 0;
  for (;;) {
    const { data, error } = await supabaseAdmin
      .from(HOT_TABLE)
      .select("stock_code, market_cap_eok")
      .gte("trade_date", startDate)
      .lte("trade_date", endDate)
      .range(from, from + HOT_TABLE_PAGE_SIZE - 1);
    if (error) throw new Error(`평균 시총 조회 실패: ${error.message}`);
    for (const row of (data ?? []) as { stock_code: string; market_cap_eok: number }[]) {
      const cur = sums.get(row.stock_code) ?? { sum: 0, count: 0 };
      cur.sum += Number(row.market_cap_eok);
      cur.count += 1;
      sums.set(row.stock_code, cur);
    }
    if (!data || data.length < HOT_TABLE_PAGE_SIZE) break;
    from += HOT_TABLE_PAGE_SIZE;
  }
  const result = new Map<string, number>();
  for (const [code, { sum, count }] of sums) result.set(code, sum / count);
  return result;
}

main().catch((error) => {
  console.error("데이터 현황 조사 중 오류:", error);
  process.exit(1);
});
