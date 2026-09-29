/**
 * [디스포저블 1회성 스크립트] beta_price_history의 과거 커버리지 격차(2016-01-01
 * ~ 기존 최오래된 저장 날짜 하루 전)를 KRX Open API로 채운다. 기존
 * scripts/backfill-index-daily-prices.ts는 "저장된 최신 날짜+1부터 어제까지"만
 * 이어받는 방향으로만 동작해 과거로는 못 가므로, 별도 스크립트로 둔다(둘 다
 * market+trade_date 키로 upsert하는 lib/betaPriceHistoryStorage.ts의
 * upsertIndexPrices를 그대로 재사용 — 기존 행은 절대 건드리지 않고 새 날짜만
 * 추가한다).
 *
 * "장기 백테스트" 벤치마크 비교 조사(2026-09-29)용 — 목표 구간을 채우고 나면 이
 * 스크립트와 대응 워크플로는 정리 PR로 제거한다.
 *
 * 호출 방식(엔드포인트, AUTH_KEY 헤더, 정확히 "코스피"/"코스닥"인 행만 채택,
 * CONCURRENCY=1 + THROTTLE_DELAY_MS + 지수 백오프 재시도)은
 * scripts/backfill-index-daily-prices.ts와 동일하게 맞췄다.
 *
 * 실행: tsx --conditions=react-server scripts/backfill-index-daily-prices-historical-gap.ts
 * 필요 환경변수: KRX_API_KEY, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 *   GAP_START_DATE(YYYY-MM-DD), GAP_END_DATE(YYYY-MM-DD)
 */

import { upsertIndexPrices } from "@/lib/betaPriceHistoryStorage";
import type { KrxMarket } from "@/lib/stockMaster";

const KRX_BASE_URL = "https://data-dbg.krx.co.kr/svc/apis/idx";
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

async function main(): Promise<void> {
  const apiKey = process.env.KRX_API_KEY;
  if (!apiKey) throw new Error("KRX_API_KEY 환경 변수가 없습니다.");
  const startDate = process.env.GAP_START_DATE;
  const endDate = process.env.GAP_END_DATE;
  if (!startDate || !endDate) throw new Error("GAP_START_DATE/GAP_END_DATE 환경 변수가 없습니다.");
  if (startDate > endDate) {
    console.log("이미 최신 상태입니다. 백필할 날짜가 없습니다.");
    return;
  }

  const markets: KrxMarket[] = ["KOSPI", "KOSDAQ"];
  const targetDates = weekdaysBetween(startDate, endDate);
  console.log(`지수 시세 과거 격차 백필 시작: ${targetDates.length}개 평일 (${startDate} ~ ${endDate})`);

  const rows: { market: KrxMarket; tradeDate: string; closePrice: number }[] = [];
  let errors = 0;
  let completed = 0;

  // 기존 backfill-index-daily-prices.ts와 동일하게 완전 순차(idx 서비스가 초당 호출
  // 한도가 낮다고 실측 확인된 바 있음, 해당 파일 상단 주석 참고) + 100건마다 저장.
  const SAVE_BATCH_SIZE = 100;
  for (const dateKey of targetDates) {
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
      if (completed % SAVE_BATCH_SIZE === 0 || completed === targetDates.length) {
        console.log(`진행: ${completed}/${targetDates.length}일 (누적 ${rows.length}행, 실패 ${errors})`);
        // 중간 저장 — 실행이 중간에 끊겨도 이미 조회한 만큼은 남긴다.
        await upsertIndexPrices(rows.splice(0, rows.length));
      }
    }
  }

  console.log(`KRX 지수 시세 과거 격차 백필 완료: 실패 ${errors}일`);
}

main().catch((error) => {
  console.error("백필 중 오류:", error);
  process.exit(1);
});
