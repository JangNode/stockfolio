/**
 * 종목 시세 원자료 hot 구간(stock_daily_prices_recent, Postgres) 매일 갱신 배치. 어제까지
 * 빠진 평일이 있으면(워크플로 실패 등으로 하루 이틀 놓친 경우 포함) 전부 이어서
 * 채운다 — Parquet처럼 파일 전체를 다시 쓸 필요 없이 그날치만 INSERT하면 되므로
 * 가볍다. .github/workflows/screening.yml 마지막 스텝으로 매 평일 실행된다. 시가총액
 * 하한(STOCK_DATA_BACKFILL_MARKET_CAP_FLOOR_EOK) 미달이어도 테마(lib/themeConfig.ts)
 * 소속 종목이면 저장한다(scripts/backfill-stock-daily-prices.ts와 동일한 필터).
 *
 * server-only로 막힌 lib/supabaseAdmin.ts를 순수 Node 스크립트에서도 재사용하려면
 * "react-server" 조건으로 실행해야 한다:
 *   tsx --conditions=react-server scripts/update-stock-daily-prices-recent.ts
 *
 * 필요 환경변수: KRX_API_KEY, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { getLatestRecentPriceDate, upsertRecentPrices, type StockDailyPriceRow } from "@/lib/stockDailyPricesStorage";
import { STOCK_DATA_BACKFILL_MARKET_CAP_FLOOR_EOK } from "@/lib/stockDataConfig";
import { getThemeFlaggedStockCodes } from "@/lib/stockMaster";

const KRX_BASE_URL = "https://data-dbg.krx.co.kr/svc/apis/sto";
// stock_daily_prices_recent가 아직 비어있을 리 없지만(시딩 스크립트로 먼저 채움),
// 혹시 비어있는 상태로 이 배치가 먼저 돌면 최근 며칠만 채우도록 상한을 둔다 — 그
// 이상 과거는 시딩 스크립트나 아카이빙 로직의 몫이다.
const MAX_LOOKBACK_DAYS = 10;

interface KrxTradeRow {
  ISU_CD: string;
  TDD_CLSPRC: string;
  TDD_OPNPRC: string;
  TDD_HGPRC: string;
  TDD_LWPRC: string;
  ACC_TRDVOL: string;
  MKTCAP: string;
  LIST_SHRS: string;
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

async function fetchKrxDaily(
  endpoint: "stk_bydd_trd" | "ksq_bydd_trd",
  basDd: string,
  apiKey: string
): Promise<KrxTradeRow[]> {
  const res = await fetch(`${KRX_BASE_URL}/${endpoint}?basDd=${basDd}`, { headers: { AUTH_KEY: apiKey } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { OutBlock_1?: KrxTradeRow[] };
  return body.OutBlock_1 ?? [];
}

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
    // 시가총액 하한 미달이어도 테마(lib/themeConfig.ts) 소속 종목이면 저장한다 —
    // 테마/업종별 등락률 순위 기능이 필요로 하는 소형주 시세도 같이 채워 넣는다.
    if (marketCapEok < STOCK_DATA_BACKFILL_MARKET_CAP_FLOOR_EOK && !themeFlaggedCodes.has(row.ISU_CD)) continue;

    const openPrice = Number(row.TDD_OPNPRC);
    const volume = Number(row.ACC_TRDVOL);
    const highPrice = Number(row.TDD_HGPRC);
    const lowPrice = Number(row.TDD_LWPRC);
    if (!Number.isFinite(openPrice) || !Number.isFinite(volume) || !Number.isFinite(highPrice) || !Number.isFinite(lowPrice)) continue;

    rows.push({
      stockCode: row.ISU_CD,
      tradeDate: dateKey,
      closePrice: Number(row.TDD_CLSPRC),
      marketCapEok,
      listedShares: Number(row.LIST_SHRS),
      openPrice,
      volume,
      highPrice,
      lowPrice,
    });
  }
  return rows;
}

async function main(): Promise<void> {
  const apiKey = process.env.KRX_API_KEY;
  if (!apiKey) throw new Error("KRX_API_KEY 환경 변수가 없습니다.");

  const themeFlaggedCodes = await getThemeFlaggedStockCodes();
  const latestStored = await getLatestRecentPriceDate();

  const endDate = new Date(); // 오늘 데이터는 정산 전일 수 있어 어제까지만.
  endDate.setUTCDate(endDate.getUTCDate() - 1);

  const startDate = new Date(endDate);
  if (latestStored) {
    startDate.setTime(new Date(latestStored + "T00:00:00Z").getTime());
    startDate.setUTCDate(startDate.getUTCDate() + 1);
  } else {
    startDate.setUTCDate(startDate.getUTCDate() - MAX_LOOKBACK_DAYS);
  }

  if (startDate > endDate) {
    console.log("이미 최신 상태입니다. 채울 날짜가 없습니다.");
    return;
  }

  const targetDates: string[] = [];
  for (const d = new Date(startDate); d <= endDate; d.setUTCDate(d.getUTCDate() + 1)) {
    if (!isWeekend(d)) targetDates.push(toDateKey(d));
  }

  console.log(`업데이트 대상: ${targetDates.length}개 평일 (${targetDates[0] ?? "없음"} ~ ${targetDates[targetDates.length - 1] ?? "없음"})`);

  let total = 0;
  for (const dateKey of targetDates) {
    const rows = await fetchAndFilterDay(dateKey, apiKey, themeFlaggedCodes);
    if (rows.length > 0) {
      await upsertRecentPrices(rows);
      total += rows.length;
    }
    console.log(`  ${dateKey}: ${rows.length}행`);
  }

  console.log(`최근 시세 갱신 완료: 총 ${total}행 저장`);
}

main().catch((error) => {
  console.error("갱신 중 오류:", error);
  process.exit(1);
});
