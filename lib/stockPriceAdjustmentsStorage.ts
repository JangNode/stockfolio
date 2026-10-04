import "server-only";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import type { AppliedAdjustment, DetectedAdjustmentEvent } from "@/lib/priceAdjustment";

const TABLE = "stock_price_adjustment_events";
const PAGE_SIZE = 1000;

/** status='applied' 이벤트를 종목별(eventDate 오름차순)로 읽는다 — 배치 전용 조정 조회에 쓴다. */
export async function loadAppliedAdjustments(): Promise<Map<string, AppliedAdjustment[]>> {
  const byCode = new Map<string, AppliedAdjustment[]>();
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabaseAdmin
      .from(TABLE)
      .select("stock_code, event_date, adjustment_factor")
      .eq("status", "applied")
      .order("stock_code", { ascending: true })
      .order("event_date", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`조정계수 조회 실패: ${error.message}`);
    for (const row of data ?? []) {
      const r = row as { stock_code: string; event_date: string; adjustment_factor: number | string };
      const list = byCode.get(r.stock_code) ?? [];
      list.push({ eventDate: r.event_date, factor: Number(r.adjustment_factor) });
      byCode.set(r.stock_code, list);
    }
    if (!data || data.length < PAGE_SIZE) break;
  }
  return byCode;
}

/** 지정한 종목들의 status='applied' 이벤트만 읽는다(추적·모의투자 방어 로직용 — 전체를 읽지 않는다). */
export async function loadAppliedAdjustmentsForCodes(stockCodes: string[]): Promise<Map<string, AppliedAdjustment[]>> {
  const byCode = new Map<string, AppliedAdjustment[]>();
  const codes = Array.from(new Set(stockCodes));
  const CHUNK = 200;
  for (let i = 0; i < codes.length; i += CHUNK) {
    const { data, error } = await supabaseAdmin
      .from(TABLE)
      .select("stock_code, event_date, adjustment_factor")
      .eq("status", "applied")
      .in("stock_code", codes.slice(i, i + CHUNK))
      .order("event_date", { ascending: true });
    if (error) throw new Error(`종목별 조정계수 조회 실패: ${error.message}`);
    for (const row of data ?? []) {
      const r = row as { stock_code: string; event_date: string; adjustment_factor: number | string };
      const list = byCode.get(r.stock_code) ?? [];
      list.push({ eventDate: r.event_date, factor: Number(r.adjustment_factor) });
      byCode.set(r.stock_code, list);
    }
  }
  return byCode;
}

/** 탐지 결과를 저장한다(종목+날짜 기준 upsert). */
export async function saveAdjustmentEvents(events: DetectedAdjustmentEvent[]): Promise<void> {
  for (let i = 0; i < events.length; i += PAGE_SIZE) {
    const batch = events.slice(i, i + PAGE_SIZE).map((e) => ({
      stock_code: e.stockCode,
      event_date: e.eventDate,
      price_ratio: e.priceRatio,
      shares_ratio: e.sharesRatio,
      volume_ratio: e.volumeRatio,
      adjustment_factor: e.adjustmentFactor,
      status: e.status,
      low_confidence_reason: e.lowConfidenceReason,
      post_adjust_close_ratio: e.holdMetrics?.postRatio ?? null,
      halt_trading_days: e.holdMetrics?.haltTradingDays ?? null,
      resume_day_change_pct: e.holdMetrics?.resumeChangePct ?? null,
      follow_5d_change_pct: e.holdMetrics?.followChangePct ?? null,
      detected_at: new Date().toISOString(),
    }));
    const { error } = await supabaseAdmin.from(TABLE).upsert(batch);
    if (error) throw new Error(`조정계수 저장 실패: ${error.message}`);
  }
}
