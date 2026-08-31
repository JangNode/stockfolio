/**
 * (1회성, 재실행 가능) 테마/업종별 등락률 히스토리 기능을 위해, 시가총액 하한
 * (STOCK_DATA_BACKFILL_MARKET_CAP_FLOOR_EOK) 미만이라 기존엔 저장하지 않았던 테마
 * 소속 소형주들의 최근 THEME_CONSTITUENTS_RETENTION_YEARS(lib/themeConfig.ts)년치
 * 시세를 stock_daily_prices_recent(hot)/Parquet(cold)에 채워 넣는다.
 * scripts/backfill-stock-daily-prices.ts, scripts/update-stock-daily-prices-recent.ts의
 * 저장 필터는 이미 "테마 소속 OR 시가총액 5천억 이상"으로 완화해뒀지만, 그 변경
 * 이전에 이미 업로드돼 있던 과거 연도 Parquet 파일에는 반영되지 않는다 — 이
 * 스크립트가 그 구간을 다시 받아 덮어쓴다(hot 구간은 매일 갱신 배치가 이미 새 필터로
 * 돌고 있어도, 배치 도입 이전 날짜는 이 스크립트로 채워야 한다).
 *
 * 오늘 기준 KIS 종목마스터의 themeFlags를 과거 전체 구간에 그대로 적용한다(과거
 * 마스터 파일이 없어 유일하게 가능한 근사 — lib/stockMaster.ts의
 * getThemeFlaggedStockCodes 참고).
 *
 * hot 구간(stock_daily_prices_recent)은 upsert라 기존 대형주 행과 부딪히지 않고
 * 안전하게 다시 써도 된다. cold 구간(연도별 Parquet)은 파일 단위 덮어쓰기라, 그 해를
 * KRX에서 통째로 다시 받아(완화된 필터로) 대형주+테마 소형주를 함께 담은 파일을 새로
 * 만든다 — scripts/backfill-stock-daily-prices.ts와 달리 yearPricesExist로 건너뛰지
 * 않고 대상 연도를 항상 다시 받는다.
 *
 * server-only로 막힌 lib/supabaseAdmin.ts를 순수 Node 스크립트에서도 재사용하려면
 * "react-server" 조건으로 실행해야 한다:
 *   tsx --conditions=react-server scripts/backfill-theme-stock-prices.ts
 *
 * 필요 환경변수: KRX_API_KEY, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import {
  hotWindowStartDate,
  upsertRecentPrices,
  uploadYearPrices,
  type StockDailyPriceRow,
} from "@/lib/stockDailyPricesStorage";
import { STOCK_DATA_BACKFILL_MARKET_CAP_FLOOR_EOK } from "@/lib/stockDataConfig";
import { THEME_CONSTITUENTS_RETENTION_YEARS } from "@/lib/themeConfig";
import { getThemeFlaggedStockCodes } from "@/lib/stockMaster";

const KRX_BASE_URL = "https://data-dbg.krx.co.kr/svc/apis/sto";
const CONCURRENCY = 8;
const CALL_RETRY_COUNT = 2;
const CALL_RETRY_DELAY_MS = 1500;
const HOT_PROGRESS_LOG_INTERVAL = 50;
const COLD_PROGRESS_LOG_INTERVAL = 100;

interface KrxTradeRow {
  ISU_CD: string;
  TDD_CLSPRC: string;
  MKTCAP: string;
  LIST_SHRS: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function isWeekend(date: Date): boolean {
  const day = date.getUTCDay();
  return day === 0 || day === 6;
}

function toBasDd(dateKey: string): string {
  return dateKey.replaceAll("-", "");
}

async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let nextIndex = 0;
  async function runOne(): Promise<void> {
    for (;;) {
      const index = nextIndex++;
      if (index >= items.length) return;
      await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runOne));
}

async function fetchKrxDaily(
  endpoint: "stk_bydd_trd" | "ksq_bydd_trd",
  basDd: string,
  apiKey: string
): Promise<KrxTradeRow[]> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= CALL_RETRY_COUNT; attempt++) {
    try {
      const res = await fetch(`${KRX_BASE_URL}/${endpoint}?basDd=${basDd}`, { headers: { AUTH_KEY: apiKey } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { OutBlock_1?: KrxTradeRow[] };
      return body.OutBlock_1 ?? [];
    } catch (error) {
      lastError = error;
      if (attempt < CALL_RETRY_COUNT) await sleep(CALL_RETRY_DELAY_MS);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** "시가총액 5천억 이상 OR 테마 소속" 필터로 하루치를 받는다 —
 * scripts/backfill-stock-daily-prices.ts의 저장 필터와 동일하다. */
async function fetchAndFilterDay(
  dateKey: string,
  apiKey: string,
  themeFlaggedCodes: Set<string>
): Promise<StockDailyPriceRow[]> {
  const basDd = toBasDd(dateKey);
  const [kospi, kosdaq] = await Promise.all([
    fetchKrxDaily("stk_bydd_trd", basDd, apiKey),
    fetchKrxDaily("ksq_bydd_trd", basDd, apiKey),
  ]);

  const rows: StockDailyPriceRow[] = [];
  for (const row of [...kospi, ...kosdaq]) {
    if (!row.ISU_CD || !row.TDD_CLSPRC || row.TDD_CLSPRC === "-" || !row.LIST_SHRS || row.LIST_SHRS === "-") continue;
    const marketCapEok = Number(row.MKTCAP) / 100_000_000;
    if (!Number.isFinite(marketCapEok)) continue;
    if (marketCapEok < STOCK_DATA_BACKFILL_MARKET_CAP_FLOOR_EOK && !themeFlaggedCodes.has(row.ISU_CD)) continue;

    rows.push({
      stockCode: row.ISU_CD,
      tradeDate: dateKey,
      closePrice: Number(row.TDD_CLSPRC),
      marketCapEok,
      listedShares: Number(row.LIST_SHRS),
    });
  }
  return rows;
}

function weekdaysInRange(start: Date, end: Date): string[] {
  const dates: string[] = [];
  for (const d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    if (!isWeekend(d)) dates.push(toDateKey(d));
  }
  return dates;
}

/** year년의 1월 1일부터 rangeEnd(그 해를 넘으면 12월 31일)까지 평일을 뽑는다.
 *
 * 시작을 backfillStartDate로 자르지 않고 항상 1월 1일부터 받는 이유: uploadYearPrices는
 * 그 해 파일을 통째로 덮어쓴다. backfillStartDate가 연도 중간(예: 2023-08-31)이면,
 * 시작을 거기서 잘라 그 이후 날짜만 다시 받아 올리면 원래 있던 그 해 1월~
 * backfillStartDate 이전 대형주 데이터가 통째로 사라진다(재현: 2023년 파일에 이미
 * 1~8월 대형주 시세가 들어있는데, 9~12월치만 다시 받아 덮어쓰면 1~8월분이 날아감).
 * 끝은 coldRangeEnd(hot 구간 시작 직전)로 자르는 게 맞다 — 그건 hot/cold 경계와
 * 일치해서(archive-stock-daily-prices.ts가 매년 그 경계로 이미 나눠 옮겨둠) 잘라도
 * 데이터가 없어지지 않는다. */
function weekdaysInYearRange(year: number, rangeEnd: Date): string[] {
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const yearEnd = new Date(Date.UTC(year, 11, 31));
  const end = yearEnd < rangeEnd ? yearEnd : rangeEnd;
  if (yearStart > end) return [];
  return weekdaysInRange(yearStart, end);
}

async function backfillHotDates(
  dates: string[],
  apiKey: string,
  themeFlaggedCodes: Set<string>
): Promise<{ rows: number; errors: number }> {
  let totalRows = 0;
  let errors = 0;
  let completed = 0;

  await runWithConcurrency(dates, CONCURRENCY, async (dateKey) => {
    try {
      const rows = await fetchAndFilterDay(dateKey, apiKey, themeFlaggedCodes);
      if (rows.length > 0) {
        await upsertRecentPrices(rows);
        totalRows += rows.length;
      }
    } catch (error) {
      errors++;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  ${dateKey} 실패: ${message}`);
    } finally {
      completed++;
      if (completed % HOT_PROGRESS_LOG_INTERVAL === 0 || completed === dates.length) {
        console.log(`  hot 구간 진행: ${completed}/${dates.length}일 (누적 ${totalRows}행, 실패 ${errors})`);
      }
    }
  });

  return { rows: totalRows, errors };
}

async function backfillColdYear(
  year: number,
  targetDates: string[],
  apiKey: string,
  themeFlaggedCodes: Set<string>
): Promise<{ rows: number; errors: number }> {
  const yearRows: StockDailyPriceRow[] = [];
  let errors = 0;
  let completed = 0;

  await runWithConcurrency(targetDates, CONCURRENCY, async (dateKey) => {
    try {
      const rows = await fetchAndFilterDay(dateKey, apiKey, themeFlaggedCodes);
      yearRows.push(...rows);
    } catch (error) {
      errors++;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  ${dateKey} 실패: ${message}`);
    } finally {
      completed++;
      if (completed % COLD_PROGRESS_LOG_INTERVAL === 0 || completed === targetDates.length) {
        console.log(`  ${year}년 진행: ${completed}/${targetDates.length}일 (누적 ${yearRows.length}행, 실패 ${errors})`);
      }
    }
  });

  // 이 해를 KRX에서 완화된 필터로 통째로 다시 받았으므로, 기존에 이미 저장돼 있던
  // 대형주 행도 이 안에 자연히 포함된다 — 기존 파일을 내려받아 합칠 필요가 없다.
  if (errors === 0) {
    await uploadYearPrices(year, yearRows);
  }

  return { rows: yearRows.length, errors };
}

async function main(): Promise<void> {
  const apiKey = process.env.KRX_API_KEY;
  if (!apiKey) throw new Error("KRX_API_KEY 환경 변수가 없습니다.");

  const themeFlaggedCodes = await getThemeFlaggedStockCodes();
  console.log(`오늘 기준 테마 소속 종목 ${themeFlaggedCodes.size}개(전체 구간에 근사 적용)`);

  // 오늘 데이터는 정산 전일 수 있어 어제까지만(오늘 이후는 상시 갱신 배치가 처리).
  const endDate = new Date();
  endDate.setUTCDate(endDate.getUTCDate() - 1);

  const backfillStartDate = new Date();
  backfillStartDate.setUTCFullYear(backfillStartDate.getUTCFullYear() - THEME_CONSTITUENTS_RETENTION_YEARS);

  const hotStartDate = new Date(hotWindowStartDate() + "T00:00:00Z");

  let totalRows = 0;
  let totalErrors = 0;

  // ===== hot 구간 (stock_daily_prices_recent, Postgres upsert) =====
  const hotRangeStart = backfillStartDate > hotStartDate ? backfillStartDate : hotStartDate;
  if (hotRangeStart <= endDate) {
    const hotDates = weekdaysInRange(hotRangeStart, endDate);
    console.log(`hot 구간 백필 시작: ${hotDates.length}개 평일 (${hotDates[0]} ~ ${hotDates[hotDates.length - 1]})`);
    const { rows, errors } = await backfillHotDates(hotDates, apiKey, themeFlaggedCodes);
    totalRows += rows;
    totalErrors += errors;
    console.log(`hot 구간 완료: ${rows}행 upsert, 실패 ${errors}건`);
  } else {
    console.log("hot 구간: 채울 날짜가 없습니다.");
  }

  // ===== cold 구간 (연도별 Parquet, 통째로 재수집해 덮어쓴다) =====
  const coldRangeEnd = new Date(hotStartDate);
  coldRangeEnd.setUTCDate(coldRangeEnd.getUTCDate() - 1);

  if (backfillStartDate <= coldRangeEnd) {
    const startYear = backfillStartDate.getUTCFullYear();
    const endYear = coldRangeEnd.getUTCFullYear();

    for (let year = startYear; year <= endYear; year++) {
      const targetDates = weekdaysInYearRange(year, coldRangeEnd);
      if (targetDates.length === 0) continue;

      console.log(`${year}년 cold 구간 재백필 시작: ${targetDates.length}개 평일`);
      const { rows, errors } = await backfillColdYear(year, targetDates, apiKey, themeFlaggedCodes);
      totalRows += rows;
      totalErrors += errors;

      if (errors > 0) {
        console.error(`${year}년에 실패가 있어 이 해는 업로드하지 않았습니다. 다시 실행하면 이 해부터 재시도합니다.`);
        console.log(`중단 시점까지 총 ${totalRows}행 저장, 실패 ${totalErrors}건`);
        return;
      }
      console.log(`${year}년 완료: ${rows}행 저장(대형주+테마 소속 종목)`);
    }
  } else {
    console.log("cold 구간: 채울 연도가 없습니다.");
  }

  console.log(`테마 종목 시세 백필 완료: 총 ${totalRows}행 저장, 실패 ${totalErrors}건`);
}

main().catch((error) => {
  console.error("백필 중 오류:", error);
  process.exit(1);
});
