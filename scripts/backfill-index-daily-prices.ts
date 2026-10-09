/**
 * 적정주가 베타 계산(RIM/잔여이익모델 1단계)에 필요한 코스피/코스닥 지수 일별
 * 종가를 KRX Open API(idx/kospi_dd_trd, idx/kosdaq_dd_trd)로 채운다
 * (beta_price_history, lib/betaPriceHistoryStorage.ts). 종목 시세 백필
 * (scripts/backfill-stock-daily-prices.ts)과 동일한 동시성/재시도 패턴을 쓴다.
 *
 * 응답의 OutBlock_1에는 코스피/코스닥 외에도 코스피200 등 하위지수 여러 행이 함께
 * 오므로, IDX_NM이 정확히 "코스피"(코스닥은 "코스닥")인 행만 취한다(.includes()가
 * 아니라 정확히 일치 — "코스피 (외국주포함)" 등 다른 행이 섞이는 걸 막는다,
 * 2026-09-04 실측 확인).
 *
 * server-only로 막힌 lib/supabaseAdmin.ts를 순수 Node 스크립트에서도 재사용하려면
 * "react-server" 조건으로 실행해야 한다:
 *   tsx --conditions=react-server scripts/backfill-index-daily-prices.ts
 *
 * 필요 환경변수: KRX_API_KEY, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *
 * 2026-09-04 최초 실행 실측: CONCURRENCY=8(종목 시세 백필과 동일 값)로 돌리니 약
 * 16초 만에(100일×2시장=200콜) HTTP 403이 쏟아지기 시작해 끝까지 회복되지 않았다
 * (784일 중 619일 실패, 그 여파로 베타가 0건 산출됨). idx 서비스는 막 승인받은
 * 서비스라 sto 서비스보다 훨씬 낮은 초당 호출 한도를 가진 것으로 추정된다.
 * CONCURRENCY=1(완전 순차)로 낮추고 호출마다 THROTTLE_DELAY_MS만큼 간격을 둬 애초에
 * 제한에 걸리지 않게 하고, 그래도 실패하면 지수 백오프로 재시도한다.
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getIndexPriceSeries, getLatestIndexPriceDate, upsertIndexPrices } from "@/lib/betaPriceHistoryStorage";
import { BETA_LOOKBACK_YEARS } from "@/lib/betaConfig";
import type { KrxMarket } from "@/lib/stockMaster";

const KRX_BASE_URL = "https://data-dbg.krx.co.kr/svc/apis/idx";
const DATA_SOURCE = "krx_index_price" as const;
const CONCURRENCY = 1;
const THROTTLE_DELAY_MS = 300;
const CALL_RETRY_COUNT = 3;
const CALL_RETRY_BASE_DELAY_MS = 4000;

const INDEX_ENDPOINTS: Record<KrxMarket, { endpoint: string; exactName: string }> = {
  KOSPI: { endpoint: "kospi_dd_trd", exactName: "코스피" },
  KOSDAQ: { endpoint: "kosdaq_dd_trd", exactName: "코스닥" },
};

interface KrxIndexRow {
  IDX_NM: string;
  CLSPRC_IDX: string;
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

function addDays(dateKey: string, days: number): string {
  const d = new Date(dateKey + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return toDateKey(d);
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

async function fetchKrxIndexDaily(market: KrxMarket, basDd: string, apiKey: string): Promise<KrxIndexRow[]> {
  const { endpoint } = INDEX_ENDPOINTS[market];
  let lastError: unknown;
  for (let attempt = 0; attempt <= CALL_RETRY_COUNT; attempt++) {
    await sleep(THROTTLE_DELAY_MS);
    try {
      const res = await fetch(`${KRX_BASE_URL}/${endpoint}?basDd=${basDd}`, { headers: { AUTH_KEY: apiKey } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { OutBlock_1?: KrxIndexRow[] };
      return body.OutBlock_1 ?? [];
    } catch (error) {
      lastError = error;
      if (attempt < CALL_RETRY_COUNT) await sleep(CALL_RETRY_BASE_DELAY_MS * 2 ** attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function weekdaysBetween(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  for (let d = startDate; d <= endDate; d = addDays(d, 1)) {
    if (!isWeekend(new Date(d + "T00:00:00Z"))) dates.push(d);
  }
  return dates;
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

// 과거 구간 추가 백필 옵션(기본 동작은 변경 없음): BACKFILL_START_DATE·BACKFILL_END_DATE(YYYY-MM-DD, 둘 다 필수)를 주면
// 그 범위의 평일만 대상으로 삼고, 이미 저장된 (시장, 날짜)는 건너뛰어 없는 날짜만 추가한다(기존 행 덮어쓰기 금지).
// BACKFILL_DRY_RUN=true면 호출 수·저장 예정 행 수를 계산하고 소수 표본 날짜(DRY_RUN_SAMPLE_DAYS개)만 조회할 뿐 저장하지 않는다.
// 이 모드에서는 체크포인트(stock_data_backfill_runs)를 기록하지 않는다 — 최신 날짜 이어받기 로직과 무관한 일회성 작업이다.
const DRY_RUN_SAMPLE_DAYS = 6;

async function runRangeBackfill(apiKey: string, startDate: string, endDate: string, dryRun: boolean): Promise<void> {
  const markets: KrxMarket[] = ["KOSPI", "KOSDAQ"];
  const existing = new Map<KrxMarket, Set<string>>();
  for (const market of markets) {
    const series = await getIndexPriceSeries(market, startDate, endDate);
    existing.set(market, new Set(series.map((p) => p.tradeDate)));
  }
  const weekdays = weekdaysBetween(startDate, endDate);
  const missingByDate = new Map<string, KrxMarket[]>();
  for (const d of weekdays) {
    const missing = markets.filter((m) => !existing.get(m)!.has(d));
    if (missing.length > 0) missingByDate.set(d, missing);
  }
  const targetDates = Array.from(missingByDate.keys());
  const plannedCalls = targetDates.reduce((sum, d) => sum + missingByDate.get(d)!.length, 0);
  console.log(
    `지수 과거 구간 백필 계획: ${startDate} ~ ${endDate} 평일 ${weekdays.length}일, 이미 저장됨 ` +
      markets.map((m) => `${m} ${existing.get(m)!.size}행`).join(" / ") +
      ` → 조회 대상 ${targetDates.length}일, 호출 ${plannedCalls}회 (동시성 ${CONCURRENCY}, 호출 간격 ${THROTTLE_DELAY_MS}ms 이상, 예상 ${Math.ceil((plannedCalls * (THROTTLE_DELAY_MS + 400)) / 60000)}분)`
  );

  if (dryRun) {
    const step = Math.max(1, Math.floor(targetDates.length / DRY_RUN_SAMPLE_DAYS));
    const sample = targetDates.filter((_, i) => i % step === 0).slice(0, DRY_RUN_SAMPLE_DAYS);
    let hits = 0;
    for (const dateKey of sample) {
      const basDd = toBasDd(dateKey);
      const parts: string[] = [];
      for (const market of missingByDate.get(dateKey)!) {
        const rows = await fetchKrxIndexDaily(market, basDd, apiKey);
        const matched = rows.find((row) => row.IDX_NM === INDEX_ENDPOINTS[market].exactName);
        const ok = !!matched && !!matched.CLSPRC_IDX && matched.CLSPRC_IDX !== "-";
        if (ok) hits++;
        parts.push(`${market} ${ok ? matched!.CLSPRC_IDX : "없음(휴장 추정)"}`);
      }
      console.log(`  표본 ${dateKey}: ${parts.join(", ")}`);
    }
    const sampleCalls = sample.reduce((s, d) => s + missingByDate.get(d)!.length, 0);
    const hitRate = sampleCalls > 0 ? hits / sampleCalls : 0;
    console.log(
      `DRY-RUN(저장 안 함): 표본 ${sample.length}일 ${sampleCalls}회 호출 중 값 ${hits}건(${(hitRate * 100).toFixed(0)}%) → ` +
        `저장 예정 행 수 추정 약 ${Math.round(plannedCalls * hitRate)}행 (휴장일은 값이 없어 저장되지 않음)`
    );
    return;
  }

  const rows: { market: KrxMarket; tradeDate: string; closePrice: number }[] = [];
  let errors = 0;
  let completed = 0;
  await runWithConcurrency(targetDates, CONCURRENCY, async (dateKey) => {
    const basDd = toBasDd(dateKey);
    try {
      for (const market of missingByDate.get(dateKey)!) {
        const indexRows = await fetchKrxIndexDaily(market, basDd, apiKey);
        const matched = indexRows.find((row) => row.IDX_NM === INDEX_ENDPOINTS[market].exactName);
        if (matched && matched.CLSPRC_IDX && matched.CLSPRC_IDX !== "-") {
          rows.push({ market, tradeDate: dateKey, closePrice: Number(matched.CLSPRC_IDX) });
        }
      }
    } catch (error) {
      errors++;
      console.error(`  ${dateKey} 실패: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      completed++;
      if (completed % 100 === 0 || completed === targetDates.length) {
        console.log(`진행: ${completed}/${targetDates.length}일 (누적 ${rows.length}행, 실패 ${errors})`);
      }
    }
  });

  // 일부 날짜가 실패했더라도 성공한 행은 저장한다(없는 행만 추가하므로 재실행으로 이어서 채울 수 있다).
  await upsertIndexPrices(rows, { insertOnly: true });
  console.log(`지수 과거 구간 백필 완료: ${rows.length}행 추가 저장(실패 ${errors}일). 실패가 있으면 같은 범위로 다시 실행하면 없는 날짜만 이어서 채운다.`);
  if (errors > 0) process.exitCode = 1;
}

async function main(): Promise<void> {
  const apiKey = process.env.KRX_API_KEY;
  if (!apiKey) throw new Error("KRX_API_KEY 환경 변수가 없습니다.");

  const rangeStart = process.env.BACKFILL_START_DATE;
  const rangeEnd = process.env.BACKFILL_END_DATE;
  if (rangeStart || rangeEnd) {
    if (!rangeStart || !rangeEnd) throw new Error("BACKFILL_START_DATE와 BACKFILL_END_DATE는 함께 지정해야 합니다.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rangeStart) || !/^\d{4}-\d{2}-\d{2}$/.test(rangeEnd) || rangeStart > rangeEnd) {
      throw new Error("BACKFILL_START_DATE/BACKFILL_END_DATE는 YYYY-MM-DD 형식이고 시작일이 종료일보다 늦을 수 없습니다.");
    }
    await runRangeBackfill(apiKey, rangeStart, rangeEnd, process.env.BACKFILL_DRY_RUN === "true");
    return;
  }

  const startedAt = new Date();
  // 오늘 데이터는 장 마감/정산 전일 수 있어 어제까지만 대상으로 한다.
  const endDate = addDays(toDateKey(new Date()), -1);

  const markets: KrxMarket[] = ["KOSPI", "KOSDAQ"];
  const startDates = await Promise.all(
    markets.map(async (market) => {
      const latest = await getLatestIndexPriceDate(market);
      if (latest) return addDays(latest, 1);
      const fallback = new Date();
      fallback.setUTCFullYear(fallback.getUTCFullYear() - BETA_LOOKBACK_YEARS);
      return toDateKey(fallback);
    })
  );
  // 두 시장 중 더 이른 시작일 하나로 통일해 날짜별 한 번씩만 조회한다(이미 채워진
  // 시장의 중복 조회는 필터링돼 그냥 버려지므로 비용은 거의 없다).
  const startDate = startDates[0] < startDates[1] ? startDates[0] : startDates[1];

  if (startDate > endDate) {
    console.log("이미 최신 상태입니다. 백필할 날짜가 없습니다.");
    return;
  }

  const targetDates = weekdaysBetween(startDate, endDate);
  console.log(`지수 시세 백필 시작: ${targetDates.length}개 평일 (${targetDates[0]} ~ ${targetDates[targetDates.length - 1]})`);

  const rows: { market: KrxMarket; tradeDate: string; closePrice: number }[] = [];
  let errors = 0;
  let completed = 0;

  await runWithConcurrency(targetDates, CONCURRENCY, async (dateKey) => {
    const basDd = toBasDd(dateKey);
    try {
      for (const market of markets) {
        const indexRows = await fetchKrxIndexDaily(market, basDd, apiKey);
        const exactName = INDEX_ENDPOINTS[market].exactName;
        const matched = indexRows.find((row) => row.IDX_NM === exactName);
        if (matched && matched.CLSPRC_IDX && matched.CLSPRC_IDX !== "-") {
          rows.push({ market, tradeDate: dateKey, closePrice: Number(matched.CLSPRC_IDX) });
        }
      }
    } catch (error) {
      errors++;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  ${dateKey} 실패: ${message}`);
    } finally {
      completed++;
      if (completed % 100 === 0 || completed === targetDates.length) {
        console.log(`진행: ${completed}/${targetDates.length}일 (누적 ${rows.length}행, 실패 ${errors})`);
      }
    }
  });

  await upsertIndexPrices(rows);
  await recordCheckpoint(startedAt, errors === 0 ? endDate : null, rows.length, errors);
  console.log(`KRX 지수 시세 백필 완료: ${rows.length}행 저장(실패 ${errors}일)`);
}

main().catch((error) => {
  console.error("백필 중 오류:", error);
  process.exit(1);
});
