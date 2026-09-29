/**
 * 종목 시세 원자료(여러 전략이 공유) 백필 1단계 — KRX 일별매매정보(stk_bydd_trd/
 * ksq_bydd_trd)로 전종목(KOSPI+KOSDAQ) 종가/시가·고가·저가·거래량·거래대금/시가총액/
 * 상장주식수를 연도별 Parquet 파일(stock-daily-prices/{year}.parquet, Supabase
 * Storage)로 만든다. Postgres가 아니라 Storage에 쓰는 이유는 supabase/migrations의
 * 20260827060000_dh_daily_prices_to_storage.sql 코멘트 참고 — 전종목 15년치를
 * Postgres에 다 넣었더니 무료 플랜 DB 용량(500MB)을 넘겨버렸다(639만 행에서
 * "No space left on device"로 중단됨).
 *
 * 2026-09-29 전종목 재백필로 시가총액 하한(STOCK_DATA_BACKFILL_MARKET_CAP_FLOOR_EOK,
 * 5천억원) 필터를 제거했다 — 그동안 시총 5천억 미달 종목은 테마/reversal_breakout
 * 매칭 이력/상장폐지 예외에 해당하지 않으면 저장하지 않았는데, discoverCandidateStockCodes
 * (1조원 기준, 실제 백테스트 유니버스)는 그대로 유지하면서도 저장 자체는 KRX 응답에
 * 있는 종목을 전부 받아두기로 했다(용량 예산은 Storage/Parquet라 여유가 있고, 나중에
 * 하한을 낮추고 싶어질 때마다 재백필하는 부담을 없앤다).
 * 거래량(ACC_TRDVOL)이 0인 날은 거래정지 등으로 실제 거래가 없었던 날이라 저장하지
 * 않는다 — KRX가 이런 날도 행 자체는 빼지 않고 마지막 체결가를 그대로 돌려주는데,
 * 이걸 그대로 저장하면 실제로 몰랐던(정지 중) 가격을 아는 것처럼 왜곡된다
 * (point-in-time 원칙, RULES.md 1번). 한진해운/STX조선해양/우경/신양오라컴 4종목의
 * 거래정지 구간이 전부 거래량 0으로 응답에 남아있다는 걸 실측으로 확인했다
 * (2026-09-21).
 * 주말(토/일)은 API 호출 없이 요일 계산만으로 건너뛴다. 평일 중 공휴일은 호출은 하되
 * 응답이 비어 있으면 그냥 건너뛴다.
 *
 * 연도 단위로 파일을 통째로 쓰기 때문에(한 해가 전부 성공해야 업로드) 재개 로직도
 * 연도 단위다 — 이미 Storage에 있는 연도는(현재 진행 중인 최신 연도 제외) 통째로
 * 건너뛴다. 중간에 실패한 해는 파일이 아예 안 올라가 있으므로 다음 실행이 그 해를
 * 처음부터 다시 받는다(한 해 최대 ~245영업일이라 다시 받아도 오래 안 걸림).
 * FORCE_REFETCH_ALL_YEARS=true를 주면 이미 있는 연도도 다시 받는다 — 스키마가 바뀌어
 * 기존 연도 파일을 전부 다시 만들어야 하는 1회성 재백필(2026-09-06 시가/거래량 컬럼
 * 추가, 2026-09-29 하한 제거+거래대금 추가)에 쓴다(평소엔 쓰지 않는다).
 * BACKFILL_YEAR_RANGE_START/BACKFILL_YEAR_RANGE_END를 주면 처리할 연도 범위를 좁힐 수
 * 있다(지정 안 하면 기존과 동일하게 BACKFILL_START_YEAR~올해 전체) — 2026-09-29
 * 재백필처럼 전종목 수천~수만 건 호출이 늘어난 실행을 몇 년씩 나눠 여러 번 돌릴 때
 * 쓴다. 각 실행은 지정된 범위만 독립적으로 처리하고 끝난다.
 *
 * server-only로 막힌 lib/supabaseAdmin.ts를 순수 Node 스크립트에서도 재사용하려면
 * "react-server" 조건으로 실행해야 한다:
 *   tsx --conditions=react-server scripts/backfill-stock-daily-prices.ts
 *
 * 필요 환경변수: KRX_API_KEY, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { uploadYearPrices, yearPricesExist, type StockDailyPriceRow } from "@/lib/stockDailyPricesStorage";

const KRX_BASE_URL = "https://data-dbg.krx.co.kr/svc/apis/sto";
const BACKFILL_START_YEAR = 2011; // 10년 백테스트(2016~) + 5년 배당 lookback
const DATA_SOURCE = "krx_price" as const;
const CONCURRENCY = 8;
const CALL_RETRY_COUNT = 2;
const CALL_RETRY_DELAY_MS = 1500;
const FORCE_REFETCH_ALL_YEARS = process.env.FORCE_REFETCH_ALL_YEARS === "true";

interface KrxTradeRow {
  ISU_CD: string;
  TDD_CLSPRC: string;
  TDD_OPNPRC: string;
  TDD_HGPRC: string;
  TDD_LWPRC: string;
  ACC_TRDVOL: string;
  ACC_TRDVAL: string;
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

async function backfillYear(
  year: number,
  targetDates: string[],
  apiKey: string
): Promise<{ rows: number; errors: number }> {
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
        if (!Number.isFinite(marketCapEok)) continue;

        const openPrice = Number(row.TDD_OPNPRC);
        const volume = Number(row.ACC_TRDVOL);
        const highPrice = Number(row.TDD_HGPRC);
        const lowPrice = Number(row.TDD_LWPRC);
        const tradingValue = Number(row.ACC_TRDVAL);
        if (
          !Number.isFinite(openPrice) ||
          !Number.isFinite(volume) ||
          !Number.isFinite(highPrice) ||
          !Number.isFinite(lowPrice) ||
          !Number.isFinite(tradingValue)
        ) {
          continue;
        }
        // 거래정지 등으로 실제 거래가 없었던 날 — 파일 상단 주석 참고(point-in-time 원칙).
        if (volume === 0) continue;

        yearRows.push({
          stockCode: row.ISU_CD,
          tradeDate: dateKey,
          closePrice: Number(row.TDD_CLSPRC),
          marketCapEok,
          listedShares: Number(row.LIST_SHRS),
          openPrice,
          volume,
          highPrice,
          lowPrice,
          tradingValue,
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

  // 분할 실행용 — 지정 안 하면 기존과 동일하게 BACKFILL_START_YEAR~올해 전체를 처리한다.
  const yearRangeStart = process.env.BACKFILL_YEAR_RANGE_START
    ? Number(process.env.BACKFILL_YEAR_RANGE_START)
    : BACKFILL_START_YEAR;
  const yearRangeEnd = process.env.BACKFILL_YEAR_RANGE_END ? Number(process.env.BACKFILL_YEAR_RANGE_END) : currentYear;

  if (FORCE_REFETCH_ALL_YEARS) {
    console.log("FORCE_REFETCH_ALL_YEARS=true — 이미 있는 연도도 전부 다시 받습니다.");
  }
  console.log(`처리 대상 연도 범위: ${yearRangeStart}~${yearRangeEnd}`);

  let totalRows = 0;
  let totalErrors = 0;

  for (let year = yearRangeStart; year <= yearRangeEnd; year++) {
    const isCurrentYear = year === currentYear;
    if (!isCurrentYear && !FORCE_REFETCH_ALL_YEARS && (await yearPricesExist(year))) {
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

    console.log(`${year}년 완료: ${rows}행 저장`);
  }

  await recordCheckpoint(startedAt, `${yearRangeEnd}-12-31`, totalRows, totalErrors);
  console.log(`KRX 시세 백필 완료: 총 ${totalRows}행 저장`);
}

main().catch((error) => {
  console.error("백필 중 오류:", error);
  process.exit(1);
});
