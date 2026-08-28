/**
 * 종목 시세 원자료(여러 전략이 공유) 백필 1단계 — KRX 일별매매정보(stk_bydd_trd/
 * ksq_bydd_trd)로 전종목(KOSPI+KOSDAQ) 종가/시가총액/상장주식수를 연도별 Parquet
 * 파일(stock-daily-prices/{year}.parquet, Supabase Storage)로 만든다. Postgres가
 * 아니라 Storage에 쓰는 이유는 supabase/migrations의
 * 20260827060000_dh_daily_prices_to_storage.sql 코멘트 참고 — 전종목 15년치를
 * Postgres에 다 넣었더니 무료 플랜 DB 용량(500MB)을 넘겨버렸다(639만 행에서
 * "No space left on device"로 중단됨).
 *
 * 시가총액이 STOCK_DATA_BACKFILL_MARKET_CAP_FLOOR_EOK(lib/stockDataConfig.ts, 5천억원)
 * 미만인 행은 애초에 저장하지 않는다 — 후보종목 기준(1조원)보다 낮게 잡아 여유를 두면서도,
 * 저장량을 크게 줄인다. 주말(토/일)은 API 호출 없이 요일 계산만으로 건너뛴다. 평일 중
 * 공휴일은 호출은 하되 응답이 비어 있으면 그냥 건너뛴다.
 *
 * 연도 단위로 파일을 통째로 쓰기 때문에(한 해가 전부 성공해야 업로드) 재개 로직도
 * 연도 단위다 — 이미 Storage에 있는 연도는(현재 진행 중인 최신 연도 제외) 통째로
 * 건너뛴다. 중간에 실패한 해는 파일이 아예 안 올라가 있으므로 다음 실행이 그 해를
 * 처음부터 다시 받는다(한 해 최대 ~245영업일이라 다시 받아도 오래 안 걸림).
 *
 * server-only로 막힌 lib/supabaseAdmin.ts를 순수 Node 스크립트에서도 재사용하려면
 * "react-server" 조건으로 실행해야 한다:
 *   tsx --conditions=react-server scripts/backfill-stock-daily-prices.ts
 *
 * 필요 환경변수: KRX_API_KEY, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { uploadYearPrices, yearPricesExist, type StockDailyPriceRow } from "@/lib/stockDailyPricesStorage";
import { STOCK_DATA_BACKFILL_MARKET_CAP_FLOOR_EOK } from "@/lib/stockDataConfig";

const KRX_BASE_URL = "https://data-dbg.krx.co.kr/svc/apis/sto";
const BACKFILL_START_YEAR = 2011; // 10년 백테스트(2016~) + 5년 배당 lookback
const DATA_SOURCE = "krx_price" as const;
const CONCURRENCY = 8;
const CALL_RETRY_COUNT = 2;
const CALL_RETRY_DELAY_MS = 1500;

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

async function recordCheckpoint(
  startedAt: Date,
  lastCompletedDate: string | null,
  rowsFetched: number,
  errorCount: number
): Promise<void> {
  const { error } = await supabaseAdmin.from("stock_data_backfill_runs").insert({
    data_source: DATA_SOURCE,
    last_completed_date: lastCompletedDate,
    started_at: startedAt.toISOString(),
    finished_at: new Date().toISOString(),
    rows_fetched: rowsFetched,
    error_count: errorCount,
  });
  if (error) console.error(`체크포인트 저장 실패: ${error.message}`);
}

/** 한 해의 대상 평일 날짜(YYYY-MM-DD) 목록. endDate를 넘으면 그 이전까지만. */
function weekdaysInYear(year: number, endDate: Date): string[] {
  const dates: string[] = [];
  const start = new Date(Date.UTC(year, 0, 1));
  const yearEnd = new Date(Date.UTC(year, 11, 31));
  const last = yearEnd < endDate ? yearEnd : endDate;
  for (const d = new Date(start); d <= last; d.setUTCDate(d.getUTCDate() + 1)) {
    if (!isWeekend(d)) dates.push(toDateKey(d));
  }
  return dates;
}

async function backfillYear(year: number, targetDates: string[], apiKey: string): Promise<{ rows: number; errors: number }> {
  const yearRows: StockDailyPriceRow[] = [];
  let errors = 0;
  let completed = 0;

  await runWithConcurrency(targetDates, CONCURRENCY, async (dateKey) => {
    const basDd = toBasDd(dateKey);
    try {
      const [kospi, kosdaq] = await Promise.all([
        fetchKrxDaily("stk_bydd_trd", basDd, apiKey),
        fetchKrxDaily("ksq_bydd_trd", basDd, apiKey),
      ]);
      for (const row of [...kospi, ...kosdaq]) {
        if (!row.ISU_CD || !row.TDD_CLSPRC || row.TDD_CLSPRC === "-" || !row.LIST_SHRS || row.LIST_SHRS === "-") {
          continue;
        }
        const marketCapEok = Number(row.MKTCAP) / 100_000_000;
        if (!Number.isFinite(marketCapEok) || marketCapEok < STOCK_DATA_BACKFILL_MARKET_CAP_FLOOR_EOK) continue;

        yearRows.push({
          stockCode: row.ISU_CD,
          tradeDate: dateKey,
          closePrice: Number(row.TDD_CLSPRC),
          marketCapEok,
          listedShares: Number(row.LIST_SHRS),
        });
      }
    } catch (error) {
      errors++;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  ${dateKey} 실패: ${message}`);
    } finally {
      completed++;
      if (completed % 100 === 0 || completed === targetDates.length) {
        console.log(`  ${year}년 진행: ${completed}/${targetDates.length}일 (누적 ${yearRows.length}행, 실패 ${errors})`);
      }
    }
  });

  if (errors === 0) {
    await uploadYearPrices(year, yearRows);
  }

  return { rows: yearRows.length, errors };
}

async function main(): Promise<void> {
  const apiKey = process.env.KRX_API_KEY;
  if (!apiKey) throw new Error("KRX_API_KEY 환경 변수가 없습니다.");

  const startedAt = new Date();
  const currentYear = new Date().getUTCFullYear();
  // 오늘 데이터는 장 마감/정산 전일 수 있어 어제까지만 대상으로 한다 — 오늘 이후는
  // 매일 도는 상시 갱신 배치(screening.yml 마지막 스텝)가 처리한다.
  const endDate = new Date();
  endDate.setUTCDate(endDate.getUTCDate() - 1);

  let totalRows = 0;
  let totalErrors = 0;

  for (let year = BACKFILL_START_YEAR; year <= currentYear; year++) {
    const isCurrentYear = year === currentYear;
    if (!isCurrentYear && (await yearPricesExist(year))) {
      console.log(`${year}년: 이미 완료됨, 건너뜀`);
      continue;
    }

    const targetDates = weekdaysInYear(year, endDate);
    if (targetDates.length === 0) continue;

    console.log(`${year}년 백필 시작: ${targetDates.length}개 평일 (${targetDates[0]} ~ ${targetDates[targetDates.length - 1]})`);
    const { rows, errors } = await backfillYear(year, targetDates, apiKey);
    totalRows += rows;
    totalErrors += errors;

    if (errors > 0) {
      console.error(`${year}년에 실패가 있어 이 해는 업로드하지 않았습니다. 다음 실행이 이 해부터 다시 시도합니다.`);
      await recordCheckpoint(startedAt, `${year - 1}-12-31`, totalRows, totalErrors);
      return;
    }

    console.log(`${year}년 완료: ${rows}행 저장(기준 미달 종목 제외)`);
  }

  await recordCheckpoint(startedAt, `${currentYear}-12-31`, totalRows, totalErrors);
  console.log(`KRX 시세 백필 완료: 총 ${totalRows}행 저장`);
}

main().catch((error) => {
  console.error("백필 중 오류:", error);
  process.exit(1);
});
