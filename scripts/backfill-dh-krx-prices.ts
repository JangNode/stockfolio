/**
 * DH전략(대형 배당·가치주) 백테스트용 과거 PER/PBR 재구성의 1단계 — KRX
 * 일별매매정보(stk_bydd_trd/ksq_bydd_trd)로 전종목(KOSPI+KOSDAQ) 종가/시가총액/
 * 상장주식수를 dh_daily_market_data에 채운다. 이 단계는 후보종목 필터링을 하지
 * 않는다 — basDd 하나로 그날 전종목이 한 번에 오기 때문에 필터링해도 호출 비용이
 * 안 줄고, 2단계(DART 재무 백필)가 "그 기간 중 단 하루라도 시가총액 1조원을 넘은
 * 적 있는 종목"을 이 표에서 직접 뽑아 쓴다(오늘 기준 대형주 리스트를 쓰면 생존편향이
 * 생긴다 — supabase/migrations의 dh_daily_market_data 테이블 코멘트 참고).
 *
 * 주말(토/일)은 API 호출 없이 요일 계산만으로 건너뛴다(호출 비용 없음). 평일 중
 * 공휴일은 호출은 하되 응답이 비어 있으면(OutBlock_1 없음/빈 배열) 그냥 건너뛴다.
 * 15년치 기준 예상 호출 수: 평일 약 4,100일 × 2개 시장 ≈ 8,200회 — KRX 일일 한도
 * 10,000회 안에 여유 있게 들어와 한 번 실행으로 끝난다. 그래도 중간에 네트워크
 * 오류 등으로 끊길 경우를 대비해 날짜 단위로 체크포인트(dh_backfill_runs)를 남기고
 * 이어받는다.
 *
 * server-only로 막힌 lib/supabaseAdmin.ts를 순수 Node 스크립트에서도 재사용하려면
 * "react-server" 조건으로 실행해야 한다:
 *   tsx --conditions=react-server scripts/backfill-dh-krx-prices.ts
 *
 * 필요 환경변수: KRX_API_KEY, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";

const KRX_BASE_URL = "https://data-dbg.krx.co.kr/svc/apis/sto";
const BACKFILL_START_DATE = "2011-01-01"; // 10년 백테스트(2016~) + 5년 배당 lookback
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

/** items를 최대 limit개까지 동시에 처리한다. worker 안 예외는 호출부가 흡수해야 한다
 * (screen-all-stocks.ts의 동명 헬퍼와 동일한 패턴 — 이 저장소는 이 정도 크기 헬퍼는
 * 스크립트마다 복붙해서 쓴다). */
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

async function fetchKrxDaily(endpoint: "stk_bydd_trd" | "ksq_bydd_trd", basDd: string, apiKey: string): Promise<KrxTradeRow[]> {
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

async function getLastCompletedDate(): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("dh_backfill_runs")
    .select("last_completed_date")
    .eq("data_source", DATA_SOURCE)
    .not("last_completed_date", "is", null)
    .order("last_completed_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`체크포인트 조회 실패: ${error.message}`);
  return data?.last_completed_date ?? null;
}

async function recordCheckpoint(
  startedAt: Date,
  lastCompletedDate: string | null,
  rowsFetched: number,
  errorCount: number
): Promise<void> {
  const { error } = await supabaseAdmin.from("dh_backfill_runs").insert({
    data_source: DATA_SOURCE,
    last_completed_date: lastCompletedDate,
    started_at: startedAt.toISOString(),
    finished_at: new Date().toISOString(),
    rows_fetched: rowsFetched,
    error_count: errorCount,
  });
  if (error) console.error(`체크포인트 저장 실패: ${error.message}`);
}

async function main(): Promise<void> {
  const apiKey = process.env.KRX_API_KEY;
  if (!apiKey) throw new Error("KRX_API_KEY 환경 변수가 없습니다.");

  const startedAt = new Date();
  const lastCompleted = await getLastCompletedDate();
  const resumeFrom = lastCompleted ? new Date(lastCompleted + "T00:00:00Z") : new Date(BACKFILL_START_DATE + "T00:00:00Z");
  if (lastCompleted) resumeFrom.setUTCDate(resumeFrom.getUTCDate() + 1);

  // 오늘 데이터는 장 마감/정산 전일 수 있어 어제까지만 대상으로 한다 — 오늘 이후는
  // 매일 도는 상시 갱신 배치(screening.yml에 추가 예정)가 처리한다.
  const endDate = new Date();
  endDate.setUTCDate(endDate.getUTCDate() - 1);

  const targetDates: string[] = [];
  for (const d = new Date(resumeFrom); d <= endDate; d.setUTCDate(d.getUTCDate() + 1)) {
    if (!isWeekend(d)) targetDates.push(toDateKey(d));
  }

  console.log(`KRX 시세 백필 시작: ${targetDates.length}개 평일 대상 (${targetDates[0] ?? "없음"} ~ ${targetDates[targetDates.length - 1] ?? "없음"})`);
  if (targetDates.length === 0) {
    console.log("처리할 날짜가 없습니다. 이미 최신 상태입니다.");
    return;
  }

  let totalRows = 0;
  let errorCount = 0;
  let lastSuccessfulDate: string | null = null;
  let completed = 0;

  // 날짜 순서대로 완료돼야 체크포인트가 안전하므로, 동시성은 날짜 배치 단위로만
  // 준다 — 한 배치(CONCURRENCY개 날짜) 전체가 끝나야 다음 배치로 넘어간다.
  for (let i = 0; i < targetDates.length; i += CONCURRENCY) {
    const chunk = targetDates.slice(i, i + CONCURRENCY);
    const results = new Map<string, { rows: number; ok: boolean }>();

    await runWithConcurrency(chunk, CONCURRENCY, async (dateKey) => {
      const basDd = toBasDd(dateKey);
      try {
        const [kospi, kosdaq] = await Promise.all([
          fetchKrxDaily("stk_bydd_trd", basDd, apiKey),
          fetchKrxDaily("ksq_bydd_trd", basDd, apiKey),
        ]);
        const allRows = [...kospi, ...kosdaq].filter(
          (row) => row.ISU_CD && row.TDD_CLSPRC && row.TDD_CLSPRC !== "-" && row.LIST_SHRS && row.LIST_SHRS !== "-"
        );

        if (allRows.length > 0) {
          const upsertRows = allRows.map((row) => ({
            stock_code: row.ISU_CD,
            trade_date: dateKey,
            close_price: Number(row.TDD_CLSPRC),
            market_cap_eok: Number(row.MKTCAP) / 100_000_000,
            listed_shares: Number(row.LIST_SHRS),
          }));
          const { error } = await supabaseAdmin.from("dh_daily_market_data").upsert(upsertRows);
          if (error) throw new Error(error.message);
        }

        results.set(dateKey, { rows: allRows.length, ok: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`  ${dateKey} 실패: ${message}`);
        results.set(dateKey, { rows: 0, ok: false });
      }
    });

    // 배치 내에서 실패가 하나라도 있으면 그 지점 이전까지만 완료로 체크포인트를 찍는다
    // (실패한 날짜 이후는 다음 실행에서 다시 시도).
    for (const dateKey of chunk) {
      const result = results.get(dateKey);
      completed++;
      if (result?.ok) {
        totalRows += result.rows;
        lastSuccessfulDate = dateKey;
      } else {
        errorCount++;
        console.error(`${dateKey} 실패로 백필을 중단합니다. 다음 실행이 여기부터 이어받습니다.`);
        await recordCheckpoint(startedAt, lastSuccessfulDate, totalRows, errorCount);
        console.log(`진행: ${completed}/${targetDates.length}일, 누적 ${totalRows}행, 마지막 완료일 ${lastSuccessfulDate ?? "없음"}`);
        return;
      }
    }

    if (completed % 100 === 0 || completed === targetDates.length) {
      console.log(`진행: ${completed}/${targetDates.length}일, 누적 ${totalRows}행`);
    }
  }

  await recordCheckpoint(startedAt, lastSuccessfulDate, totalRows, errorCount);
  console.log(`KRX 시세 백필 완료: 총 ${totalRows}행, 마지막 완료일 ${lastSuccessfulDate ?? "없음"}`);
}

main().catch((error) => {
  console.error("백필 중 오류:", error);
  process.exit(1);
});
