/**
 * 분할·병합(액면분할/병합) 조정계수 스캔 배치. 전 종목(상장폐지 포함) 원가 시세(Parquet)에서
 * 이벤트를 자체 탐지(가격비 + 상장주식수 + 거래량 교차검증, lib/priceAdjustment.ts)해
 * stock_price_adjustment_events에 저장한다. 신뢰도 높은 것('applied')만 장기 백테스트 배치가
 * 적용하고, 나머지는 목록으로만 남긴다. 원본 Parquet는 건드리지 않는다.
 *
 * 로그로 보정 전/후 일간 ±30% 이상 종목-일 수, 남은 건의 성격, 알려진 사례의 연속성,
 * 자동/미적용 이벤트 수를 함께 남긴다.
 *
 * 실행: npm run scan:price-adjustment-events
 * 필요 환경변수: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadAllStockSeriesFromParquet, type StockDailyPriceRow } from "@/lib/stockDailyPricesStorage";
import { loadAppliedAdjustments, saveAdjustmentEvents } from "@/lib/stockPriceAdjustmentsStorage";
import {
  applyAdjustmentsInPlace,
  buildTradingDayIndex,
  computeHoldMetrics,
  computePostRatio,
  detectAdjustmentEvents,
  type AppliedAdjustment,
  type DetectedAdjustmentEvent,
} from "@/lib/priceAdjustment";
import {
  POST_RATIO_LOWER,
  POST_RATIO_OUT_OF_RANGE_REASON,
  POST_RATIO_UPPER,
  PRICE_ADJUSTMENT_LOAD_FROM_YEAR,
  PRICE_ADJUSTMENT_SCAN_FROM_DATE,
  PRICE_JUMP_RATIO_LOWER,
  PRICE_JUMP_RATIO_UPPER,
  SHARES_CHANGE_MIN_RATIO,
} from "@/lib/priceAdjustmentConfig";

// 실험·검증 옵션(기본값=현재 동작): 스캔 시작일/시세 로드 시작 연도를 환경변수로 앞당길 수 있다
// (예: 2010-01-01 / 2010 — 2010~2014 구간 탐지). 탐지 규칙·기준값은 그대로다.
// SCAN_DRY_RUN=true면 stock_price_adjustment_events에 저장하지 않고 분류 결과만 출력한다.
const SCAN_FROM_DATE = process.env.PRICE_ADJUSTMENT_SCAN_FROM_DATE || PRICE_ADJUSTMENT_SCAN_FROM_DATE;
const LOAD_FROM_YEAR = Number(process.env.PRICE_ADJUSTMENT_LOAD_FROM_YEAR) || PRICE_ADJUSTMENT_LOAD_FROM_YEAR;
const SCAN_DRY_RUN = process.env.SCAN_DRY_RUN === "true";
// PRICE_ADJUSTMENT_SCAN_TO_DATE(YYYY-MM-DD, 이 날짜 미만만)를 주면 그 이전 날짜의 이벤트만 저장 대상으로 삼고
// 시세도 그 연도까지만 읽는다 — 예: 2010-01-01~2015-01-01 미만만 저장하고 기존 2015년 이후 이벤트는 건드리지 않는다.
// 저장된 행은 event_date 범위로 식별·되돌릴 수 있다.
const SCAN_TO_DATE = process.env.PRICE_ADJUSTMENT_SCAN_TO_DATE || "";

// 알려진 사례(보정 연속성 확인용): 삼성전자 2018-05-04 50:1 분할, 카카오 2021-04-15 5:1 분할.
const KNOWN_CASES = [
  { code: "005930", date: "2018-05-04", label: "삼성전자 50:1 분할" },
  { code: "035720", date: "2021-04-15", label: "카카오 5:1 분할" },
];

function isJump(prev: StockDailyPriceRow, cur: StockDailyPriceRow): boolean {
  if (!(prev.closePrice > 0) || !(cur.closePrice > 0)) return false;
  const r = cur.closePrice / prev.closePrice;
  return r <= PRICE_JUMP_RATIO_LOWER || r >= PRICE_JUMP_RATIO_UPPER;
}

function countJumps(seriesByCode: Map<string, StockDailyPriceRow[]>): number {
  let count = 0;
  for (const rows of seriesByCode.values()) {
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].tradeDate >= SCAN_FROM_DATE && isJump(rows[i - 1], rows[i])) count++;
    }
  }
  return count;
}

function describeRawAround(rows: StockDailyPriceRow[], date: string): string {
  const i = rows.findIndex((r) => r.tradeDate === date);
  if (i < 1) return "행 없음";
  return `${rows[i - 1].tradeDate} 종가 ${rows[i - 1].closePrice} → ${rows[i].tradeDate} 종가 ${rows[i].closePrice}`;
}

async function main(): Promise<void> {
  const startedMs = Date.now();
  const seriesByCode = await loadAllStockSeriesFromParquet(LOAD_FROM_YEAR, SCAN_TO_DATE ? Number(SCAN_TO_DATE.slice(0, 4)) : new Date().getUTCFullYear());
  console.log(`전 종목 시세 로드: ${seriesByCode.size}종목, ${((Date.now() - startedMs) / 1000).toFixed(0)}초`);

  const jumpsBefore = countJumps(seriesByCode);

  const rawKnown = new Map<string, string>();
  for (const c of KNOWN_CASES) {
    const rows = seriesByCode.get(c.code);
    if (rows) rawKnown.set(c.code, describeRawAround(rows, c.date));
  }

  const events: DetectedAdjustmentEvent[] = [];
  const tradingDayIndex = buildTradingDayIndex(seriesByCode);
  for (const rows of seriesByCode.values()) {
    events.push(...detectAdjustmentEvents(rows, SCAN_FROM_DATE, tradingDayIndex));
  }

  if (SCAN_TO_DATE) {
    const kept = events.filter((e) => e.eventDate < SCAN_TO_DATE);
    events.length = 0;
    events.push(...kept);
    const { count, error: countError } = await supabaseAdmin
      .from("stock_price_adjustment_events")
      .select("*", { count: "exact", head: true })
      .gte("event_date", SCAN_FROM_DATE)
      .lt("event_date", SCAN_TO_DATE);
    if (countError) throw new Error(`기존 행 수 조회 실패: ${countError.message}`);
    console.log(`저장 범위 ${SCAN_FROM_DATE} ~ ${SCAN_TO_DATE} 미만: 대상 이벤트 ${events.length}건, 테이블에 이미 있는 행 ${count}건`);
  }

  // 보류 규칙: 이미 적용돼 있던 이벤트는 상태·계수를 그대로 두고(범위 밖 개수만 집계), 새로 적용되려는
  // 이벤트가 보정 후 전후 종가 비율 범위 밖이면 적용하지 않고 점검 목록으로 남긴다.
  const previouslyApplied = await loadAppliedAdjustments();
  const outOfRange = (r: number | null): boolean => r === null || r < POST_RATIO_LOWER || r > POST_RATIO_UPPER;
  let previouslyAppliedOutOfRange = 0;
  let newlyApplied = 0;
  let held = 0;
  for (const e of events) {
    if (e.status !== "applied") continue;
    const rows = seriesByCode.get(e.stockCode);
    if (!rows) continue;
    const old = previouslyApplied.get(e.stockCode)?.find((a) => a.eventDate === e.eventDate);
    if (old) {
      if (outOfRange(computePostRatio(rows, e.eventDate, old.factor))) {
        previouslyAppliedOutOfRange++;
        e.adjustmentFactor = old.factor; // 범위 밖인 기존 이벤트의 계수는 지금은 바꾸지 않는다.
      }
      continue;
    }
    if (outOfRange(computePostRatio(rows, e.eventDate, e.adjustmentFactor))) {
      e.status = "low_confidence";
      e.lowConfidenceReason = POST_RATIO_OUT_OF_RANGE_REASON;
      e.holdMetrics = computeHoldMetrics(rows, e.eventDate, e.adjustmentFactor, tradingDayIndex) ?? undefined;
      held++;
    } else {
      newlyApplied++;
    }
  }
  console.log(
    `보류 규칙(보정 후 전후 종가 비율 ${POST_RATIO_LOWER}~${POST_RATIO_UPPER}): 새로 적용 ${newlyApplied}건, 보류 ${held}건, ` +
      `기존 적용 ${previouslyApplied.size}종목 중 범위 밖 ${previouslyAppliedOutOfRange}건(계수 유지)`
  );
  for (const e of events.filter((x) => x.lowConfidenceReason === POST_RATIO_OUT_OF_RANGE_REASON)) {
    const m = e.holdMetrics;
    console.log(
      `  [보류] ${e.stockCode} ${e.eventDate} 가격비 ${e.priceRatio.toFixed(3)} 주식수비 ${e.sharesRatio.toFixed(3)} ` +
        `거래정지 ${m?.haltTradingDays ?? "-"}일 재개일 ${m ? m.resumeChangePct.toFixed(1) : "-"}% 후속 ${m?.followChangePct != null ? m.followChangePct.toFixed(1) : "-"}%`
    );
  }
  const applied = events.filter((e) => e.status === "applied");
  const lowConfidence = events.filter((e) => e.status === "low_confidence");
  const reasonCounts = new Map<string, number>();
  for (const e of lowConfidence) {
    const key = e.lowConfidenceReason ?? "unknown";
    reasonCounts.set(key, (reasonCounts.get(key) ?? 0) + 1);
  }
  console.log(
    `이벤트 후보 ${events.length}건: 자동 적용 ${applied.length}건, 미적용(목록만) ${lowConfidence.length}건 ` +
      `(${Array.from(reasonCounts).map(([k, v]) => `${k} ${v}`).join(", ")})`
  );

  if (SCAN_DRY_RUN) {
    console.log("SCAN_DRY_RUN=true — stock_price_adjustment_events에 저장하지 않습니다.");
  } else {
    await saveAdjustmentEvents(events);
    console.log("stock_price_adjustment_events 저장 완료");
  }

  // 보정 적용(제자리) 후 재집계.
  const byCode = new Map<string, AppliedAdjustment[]>();
  for (const e of applied) {
    const list = byCode.get(e.stockCode) ?? [];
    list.push({ eventDate: e.eventDate, factor: e.adjustmentFactor });
    byCode.set(e.stockCode, list);
  }
  for (const [code, adj] of byCode) {
    adj.sort((a, b) => a.eventDate.localeCompare(b.eventDate));
    const rows = seriesByCode.get(code);
    if (rows) applyAdjustmentsInPlace(rows, adj);
  }

  const jumpsAfter = countJumps(seriesByCode);
  console.log(
    `\n일간 ±30% 이상 종목-일 수(${SCAN_FROM_DATE}~): 보정 전 ${jumpsBefore} → 보정 후 ${jumpsAfter} ` +
      `(감소 ${jumpsBefore - jumpsAfter}건)`
  );

  // 남은 건의 성격.
  let remainingWithShares = 0;
  let remainingStreak = 0;
  let remainingSingle = 0;
  for (const rows of seriesByCode.values()) {
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].tradeDate < SCAN_FROM_DATE || !isJump(rows[i - 1], rows[i])) continue;
      const sharesRatio = rows[i - 1].listedShares > 0 ? rows[i].listedShares / rows[i - 1].listedShares : 1;
      if (sharesRatio >= SHARES_CHANGE_MIN_RATIO || sharesRatio <= 1 / SHARES_CHANGE_MIN_RATIO) {
        remainingWithShares++;
        continue;
      }
      const moveSign = Math.sign(rows[i].closePrice - rows[i - 1].closePrice);
      const nearStreak = (a: StockDailyPriceRow | undefined, b: StockDailyPriceRow | undefined): boolean =>
        !!a && !!b && a.closePrice > 0 && Math.sign(b.closePrice - a.closePrice) === moveSign &&
        Math.abs(b.closePrice / a.closePrice - 1) >= 0.2;
      if (nearStreak(rows[i - 2], rows[i - 1]) || nearStreak(rows[i], rows[i + 1])) remainingStreak++;
      else remainingSingle++;
    }
  }
  console.log(
    `남은 건의 성격: 주식수 변화 동반(미적용 이벤트) ${remainingWithShares}건 / ` +
      `연속 급등락(상하한가 연속 추정) ${remainingStreak}건 / ` +
      `단일일 급등락(주식수 변화 없음 — 실제 급등락 또는 미탐지 이벤트 의심) ${remainingSingle}건`
  );

  // 알려진 사례 + 가장 큰 병합 사례.
  console.log("\n[알려진 사례 보정 연속성]");
  for (const c of KNOWN_CASES) {
    const rows = seriesByCode.get(c.code);
    const event = applied.find((e) => e.stockCode === c.code && e.eventDate === c.date);
    if (!rows) {
      console.log(`  ${c.label}: 시세 없음`);
      continue;
    }
    console.log(
      `  ${c.label}: 원가 ${rawKnown.get(c.code)} | 이벤트 ${event ? `적용(주식수비 ${event.sharesRatio.toFixed(2)}, 계수 ${event.adjustmentFactor.toFixed(4)})` : "미적용/미탐지"} | ` +
        `보정 후 ${describeRawAround(rows, c.date)}`
    );
  }
  const reverse = applied.filter((e) => e.sharesRatio < 1).sort((a, b) => a.sharesRatio - b.sharesRatio)[0];
  if (reverse) {
    const rows = seriesByCode.get(reverse.stockCode);
    console.log(
      `  병합 사례 ${reverse.stockCode} ${reverse.eventDate}(주식수비 ${reverse.sharesRatio.toFixed(3)}): ` +
        `보정 후 ${rows ? describeRawAround(rows, reverse.eventDate) : "-"}`
    );
  }

  const usage = process.resourceUsage();
  console.log(
    `\n실행 시간 ${((Date.now() - startedMs) / 1000).toFixed(0)}초, 최대 메모리(RSS) ${(usage.maxRSS / 1024).toFixed(0)}MB`
  );
}

main().catch((error) => {
  console.error("조정계수 스캔 중 오류:", error);
  process.exit(1);
});
