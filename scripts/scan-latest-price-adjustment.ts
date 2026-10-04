/**
 * 일일 증분 조정계수 스캔. 일일 시세 저장(update-stock-daily-prices-recent.ts) 직후, 최신 거래일부터
 * 거슬러 올라간 최근 INCREMENTAL_SCAN_EVENT_TRADING_DAYS 거래일에 걸린 이벤트만 기존 탐지 규칙
 * (가격비·상장주식수·시총 연속·거래정지 직후 거래량 생략·보류 규칙, lib/priceAdjustment.ts)으로 판정해
 * stock_price_adjustment_events에 등록한다 — 전체 재스캔(주간, scan-price-adjustment-events.ts)이 아니다.
 * 이미 'applied'인 행은 건드리지 않는다(주간 전체 스캔이 더 많은 정보로 확정한 값을 약하게 덮어쓰지 않도록).
 *
 * 필요 환경변수: KRX_API_KEY, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getLatestRecentPriceDate, type StockDailyPriceRow } from "@/lib/stockDailyPricesStorage";
import { saveAdjustmentEvents } from "@/lib/stockPriceAdjustmentsStorage";
import { computePostRatio, detectAdjustmentEvents, type DetectedAdjustmentEvent } from "@/lib/priceAdjustment";
import {
  INCREMENTAL_SCAN_EVENT_TRADING_DAYS,
  POST_RATIO_LOWER,
  POST_RATIO_OUT_OF_RANGE_REASON,
  POST_RATIO_UPPER,
} from "@/lib/priceAdjustmentConfig";

const KRX_BASE_URL = "https://data-dbg.krx.co.kr/svc/apis/sto";
const MAX_CALENDAR_DAYS_BACK = 14;

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

async function fetchKrxDaily(endpoint: "stk_bydd_trd" | "ksq_bydd_trd", dateKey: string, apiKey: string): Promise<KrxTradeRow[]> {
  const res = await fetch(`${KRX_BASE_URL}/${endpoint}?basDd=${dateKey.replaceAll("-", "")}`, { headers: { AUTH_KEY: apiKey } });
  if (!res.ok) throw new Error(`KRX HTTP ${res.status} (${endpoint} ${dateKey})`);
  return ((await res.json()) as { OutBlock_1?: KrxTradeRow[] }).OutBlock_1 ?? [];
}

/** 전 종목(필터 없음, 거래정지 종목은 거래량 0 그대로)의 하루치 행. */
async function fetchAllRows(dateKey: string, apiKey: string): Promise<StockDailyPriceRow[]> {
  const [kospi, kosdaq] = await Promise.all([fetchKrxDaily("stk_bydd_trd", dateKey, apiKey), fetchKrxDaily("ksq_bydd_trd", dateKey, apiKey)]);
  const rows: StockDailyPriceRow[] = [];
  for (const r of [...kospi, ...kosdaq]) {
    if (!r.ISU_CD || !r.TDD_CLSPRC || r.TDD_CLSPRC === "-" || !r.LIST_SHRS || r.LIST_SHRS === "-") continue;
    const marketCapEok = Number(r.MKTCAP) / 100_000_000;
    const nums = [r.TDD_OPNPRC, r.TDD_HGPRC, r.TDD_LWPRC, r.ACC_TRDVOL, r.ACC_TRDVAL].map(Number);
    if (!Number.isFinite(marketCapEok) || nums.some((n) => !Number.isFinite(n))) continue;
    rows.push({
      stockCode: r.ISU_CD,
      tradeDate: dateKey,
      closePrice: Number(r.TDD_CLSPRC),
      marketCapEok,
      listedShares: Number(r.LIST_SHRS),
      openPrice: nums[0],
      highPrice: nums[1],
      lowPrice: nums[2],
      volume: nums[3],
      tradingValue: nums[4],
    });
  }
  return rows;
}

async function main(): Promise<void> {
  const startedMs = Date.now();
  const apiKey = process.env.KRX_API_KEY;
  if (!apiKey) throw new Error("KRX_API_KEY 환경 변수가 없습니다.");
  const latest = await getLatestRecentPriceDate();
  if (!latest) {
    console.log("최근 시세 표가 비어 있어 증분 스캔을 건너뜁니다.");
    return;
  }

  // 최신 거래일부터 거슬러 (이벤트 거래일 수 + 1)개의 거래일(직전일 비교용 1일 포함) 행을 모은다.
  const needDays = INCREMENTAL_SCAN_EVENT_TRADING_DAYS + 1;
  const rowsByDate = new Map<string, StockDailyPriceRow[]>();
  for (let back = 0; back <= MAX_CALENDAR_DAYS_BACK && rowsByDate.size < needDays; back++) {
    const d = new Date(latest + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - back);
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    const dateKey = d.toISOString().slice(0, 10);
    const rows = await fetchAllRows(dateKey, apiKey);
    if (rows.length > 0) rowsByDate.set(dateKey, rows);
  }
  const dates = Array.from(rowsByDate.keys()).sort();
  if (dates.length < 2) throw new Error(`증분 스캔에 필요한 거래일이 부족합니다(${dates.join(",")})`);
  const tradingDayIndex = new Map(dates.map((d, i) => [d, i]));

  const byCode = new Map<string, StockDailyPriceRow[]>();
  for (const date of dates) {
    for (const row of rowsByDate.get(date)!) {
      const list = byCode.get(row.stockCode) ?? [];
      list.push(row);
      byCode.set(row.stockCode, list);
    }
  }

  const scanFrom = dates[1]; // dates[0]은 직전일 비교용
  const detected: DetectedAdjustmentEvent[] = [];
  for (const rows of byCode.values()) detected.push(...detectAdjustmentEvents(rows, scanFrom, tradingDayIndex));

  // 이미 applied인 행은 건드리지 않는다.
  const { data: existing, error } = await supabaseAdmin
    .from("stock_price_adjustment_events")
    .select("stock_code, event_date, status")
    .gte("event_date", scanFrom);
  if (error) throw new Error(`기존 이벤트 조회 실패: ${error.message}`);
  const appliedKeys = new Set((existing ?? []).filter((e) => e.status === "applied").map((e) => `${e.stock_code}:${e.event_date}`));

  let held = 0;
  const toSave: DetectedAdjustmentEvent[] = [];
  for (const e of detected) {
    if (appliedKeys.has(`${e.stockCode}:${e.eventDate}`)) continue;
    if (e.status === "applied") {
      const ratio = computePostRatio(byCode.get(e.stockCode)!, e.eventDate, e.adjustmentFactor);
      if (ratio === null || ratio < POST_RATIO_LOWER || ratio > POST_RATIO_UPPER) {
        e.status = "low_confidence";
        e.lowConfidenceReason = POST_RATIO_OUT_OF_RANGE_REASON;
        held++;
      }
    }
    toSave.push(e);
  }
  // 검증용: INCREMENTAL_SCAN_DRY_RUN=true면 저장하지 않고 결과만 출력한다(진단 종료 후 제거 예정).
  if (process.env.INCREMENTAL_SCAN_DRY_RUN !== "true") await saveAdjustmentEvents(toSave);

  const appliedNow = toSave.filter((e) => e.status === "applied");
  console.log(
    `증분 스캔(${dates[0]}~${dates[dates.length - 1]}, 이벤트 대상 ${dates.length - 1}거래일): 후보 ${detected.length}건, ` +
      `저장 ${toSave.length}건(새로 적용 ${appliedNow.length}건, 보류 ${held}건, 이미 적용돼 있어 건너뜀 ${detected.length - toSave.length}건)`
  );
  for (const e of appliedNow) console.log(`  [적용] ${e.stockCode} ${e.eventDate} 주식수비 ${e.sharesRatio.toFixed(3)} 계수 ${e.adjustmentFactor.toFixed(4)}`);
  console.log(`실행 시간 ${((Date.now() - startedMs) / 1000).toFixed(1)}초`);
}

main().catch((e) => {
  console.error("증분 조정계수 스캔 중 오류:", e);
  process.exit(1);
});
