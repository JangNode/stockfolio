/**
 * 디스포저블 진단(DB 쓰기 없음): 탐지 규칙 개선(거래정지 직후 거래량 검증 생략 + 보정계수 스냅)의 영향 검증.
 * DB의 현재(옛 규칙) 이벤트와 새 규칙으로 다시 탐지한 이벤트를 비교한다.
 */
import { loadAllStockSeriesFromParquet } from "@/lib/stockDailyPricesStorage";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { buildTradingDayIndex, detectAdjustmentEvents, type DetectedAdjustmentEvent } from "@/lib/priceAdjustment";
import { PRICE_ADJUSTMENT_LOAD_FROM_YEAR, PRICE_ADJUSTMENT_SCAN_FROM_DATE } from "@/lib/priceAdjustmentConfig";

const FOCUS_STOCKS = ["097230", "005110", "111870"];
const SAMPLE_SIZE = 10;
const ABNORMAL_ADJUSTED_RATIO_LOWER = 0.77;
const ABNORMAL_ADJUSTED_RATIO_UPPER = 1.3;

interface OldEvent {
  stock_code: string;
  event_date: string;
  shares_ratio: number;
  adjustment_factor: number;
  status: string;
  low_confidence_reason: string | null;
}

async function loadOldEvents(): Promise<OldEvent[]> {
  const out: OldEvent[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabaseAdmin
      .from("stock_price_adjustment_events")
      .select("stock_code,event_date,shares_ratio,adjustment_factor,status,low_confidence_reason")
      .order("stock_code")
      .order("event_date")
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data as OldEvent[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

// 고정 시드 의사난수(재현 가능한 무작위 표본).
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function main(): Promise<void> {
  const oldEvents = await loadOldEvents();
  const oldByKey = new Map(oldEvents.map((e) => [`${e.stock_code}:${e.event_date}`, e]));
  const raw = await loadAllStockSeriesFromParquet(PRICE_ADJUSTMENT_LOAD_FROM_YEAR, new Date().getUTCFullYear());
  const tradingDayIndex = buildTradingDayIndex(raw);
  const newEvents: DetectedAdjustmentEvent[] = [];
  for (const rows of raw.values()) newEvents.push(...detectAdjustmentEvents(rows, PRICE_ADJUSTMENT_SCAN_FROM_DATE, tradingDayIndex));

  const oldApplied = oldEvents.filter((e) => e.status === "applied").length;
  const newApplied = newEvents.filter((e) => e.status === "applied");
  console.log(`이벤트 후보: 옛 규칙 ${oldEvents.length}건(적용 ${oldApplied}) / 새 규칙 ${newEvents.length}건(적용 ${newApplied.length})`);

  // 새로 적용되는 이벤트(옛: low_confidence, 새: applied).
  const newlyApplied = newApplied.filter((e) => oldByKey.get(`${e.stockCode}:${e.eventDate}`)?.status !== "applied");
  const kind = (e: DetectedAdjustmentEvent): string => `${e.sharesRatio > 1 ? "분할" : "병합"}${Math.abs(e.adjustmentFactor * e.sharesRatio - 1) > 1e-9 ? "·스냅" : "·계산값"}`;
  const kindCounts = new Map<string, number>();
  for (const e of newlyApplied) kindCounts.set(kind(e), (kindCounts.get(kind(e)) ?? 0) + 1);
  const reasonCounts = new Map<string, number>();
  for (const e of newlyApplied) {
    const r = oldByKey.get(`${e.stockCode}:${e.eventDate}`)?.low_confidence_reason ?? "(옛 목록에 없음)";
    reasonCounts.set(r, (reasonCounts.get(r) ?? 0) + 1);
  }
  console.log(
    `\n[새로 적용] ${newlyApplied.length}건 — ${Array.from(kindCounts).map(([k, v]) => `${k} ${v}`).join(", ")} | 옛 미적용 사유: ${Array.from(reasonCounts).map(([k, v]) => `${k} ${v}`).join(", ")}`
  );
  const lostApplied = oldEvents.filter((e) => e.status === "applied" && !newApplied.some((n) => n.stockCode === e.stock_code && n.eventDate === e.event_date));
  console.log(`[옛 적용 → 새 미적용] ${lostApplied.length}건`);

  // 새로 적용되는 이벤트 무작위 10건: 이벤트 직전 종가 × 새 계수 / 이벤트일 종가 (1에 가까울수록 연속).
  const rand = mulberry32(20261004);
  const pool = [...newlyApplied];
  const sample: DetectedAdjustmentEvent[] = [];
  while (sample.length < SAMPLE_SIZE && pool.length > 0) sample.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
  console.log("\n[새로 적용 무작위 표본] 코드 이벤트일 | 구분 | 직전종가→이벤트일종가 | 계수 | 보정후 직전종가/이벤트일종가 | 거래량비");
  let abnormal = 0;
  for (const e of sample) {
    const rows = raw.get(e.stockCode)!;
    const i = rows.findIndex((r) => r.tradeDate === e.eventDate);
    const prev = rows[i - 1];
    const cur = rows[i];
    const continuity = (prev.closePrice * e.adjustmentFactor) / cur.closePrice;
    const flag = continuity < ABNORMAL_ADJUSTED_RATIO_LOWER || continuity > ABNORMAL_ADJUSTED_RATIO_UPPER ? " ⚠" : "";
    if (flag) abnormal++;
    console.log(
      `  ${e.stockCode} ${e.eventDate} | ${kind(e)} 주식수비 ${e.sharesRatio.toFixed(3)} | ${prev.tradeDate} ${prev.closePrice}→${cur.closePrice} | 계수 ${e.adjustmentFactor.toFixed(4)} | ${continuity.toFixed(3)}${flag} | 거래량비 ${e.volumeRatio.toFixed(2)}`
    );
  }
  console.log(`  표본 ${sample.length}건 중 이상(보정 후 비율이 ${ABNORMAL_ADJUSTED_RATIO_LOWER}~${ABNORMAL_ADJUSTED_RATIO_UPPER} 밖) ${abnormal}건`);

  // 새로 적용되는 전체의 보정 후 연속성 분포.
  const buckets = { "0.9~1.1": 0, "0.77~0.9 또는 1.1~1.3": 0, "그 밖": 0 };
  for (const e of newlyApplied) {
    const rows = raw.get(e.stockCode)!;
    const i = rows.findIndex((r) => r.tradeDate === e.eventDate);
    const c = (rows[i - 1].closePrice * e.adjustmentFactor) / rows[i].closePrice;
    if (c >= 0.9 && c <= 1.1) buckets["0.9~1.1"]++;
    else if (c >= ABNORMAL_ADJUSTED_RATIO_LOWER && c <= ABNORMAL_ADJUSTED_RATIO_UPPER) buckets["0.77~0.9 또는 1.1~1.3"]++;
    else buckets["그 밖"]++;
  }
  console.log(`[새로 적용 전체 ${newlyApplied.length}건 보정 후 연속성 분포] ${JSON.stringify(buckets)}`);

  // 이미 적용돼 있던 이벤트의 계수 변화(스냅 영향).
  const changed: { code: string; date: string; oldF: number; newF: number; rel: number }[] = [];
  for (const e of newApplied) {
    const old = oldByKey.get(`${e.stockCode}:${e.eventDate}`);
    if (old?.status !== "applied") continue;
    const rel = Math.abs(e.adjustmentFactor / Number(old.adjustment_factor) - 1);
    if (rel > 1e-9) changed.push({ code: e.stockCode, date: e.eventDate, oldF: Number(old.adjustment_factor), newF: e.adjustmentFactor, rel });
  }
  changed.sort((a, b) => b.rel - a.rel);
  const maxChange = changed[0];
  console.log(
    `\n[기존 적용 이벤트 계수 변화] ${changed.length}건 / 기존 적용 ${oldApplied}건, 최대 변화폭 ${maxChange ? `${(maxChange.rel * 100).toFixed(2)}% (${maxChange.code} ${maxChange.date} ${maxChange.oldF.toFixed(4)}→${maxChange.newF.toFixed(4)})` : "-"}`
  );

  // 097230 / 005110 / 111870.
  console.log("\n[지정 3종목]");
  for (const code of FOCUS_STOCKS) {
    const list = newEvents.filter((e) => e.stockCode === code);
    for (const e of list) {
      const old = oldByKey.get(`${e.stockCode}:${e.eventDate}`);
      console.log(
        `  ${code} ${e.eventDate}: 옛 ${old?.status ?? "-"}${old?.low_confidence_reason ? `(${old.low_confidence_reason})` : ""} → 새 ${e.status}${e.lowConfidenceReason ? `(${e.lowConfidenceReason})` : ""} 주식수비 ${e.sharesRatio.toFixed(3)} 계수 ${e.adjustmentFactor.toFixed(4)}`
      );
    }
    if (list.length === 0) console.log(`  ${code}: 후보 없음`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
