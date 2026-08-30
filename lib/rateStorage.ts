import "server-only";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import type { RatePoint } from "@/lib/rateChangeDetection";

export async function getLatestUsFedRate(): Promise<RatePoint | null> {
  const { data, error } = await supabaseAdmin
    .from("us_fed_funds_rate")
    .select("effective_date, target_upper_pct, target_lower_pct")
    .order("effective_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`미국 기준금리 최신값 조회 실패: ${error.message}`);
  if (!data) return null;
  return {
    effectiveDate: data.effective_date,
    values: [Number(data.target_upper_pct), Number(data.target_lower_pct)],
  };
}

export async function upsertUsFedRates(points: RatePoint[]): Promise<void> {
  if (points.length === 0) return;
  const { error } = await supabaseAdmin.from("us_fed_funds_rate").upsert(
    points.map((p) => ({
      effective_date: p.effectiveDate,
      target_upper_pct: p.values[0],
      target_lower_pct: p.values[1],
      updated_at: new Date().toISOString(),
    }))
  );
  if (error) throw new Error(`미국 기준금리 저장 실패: ${error.message}`);
}

export async function getLatestKrBaseRate(): Promise<RatePoint | null> {
  const { data, error } = await supabaseAdmin
    .from("kr_base_rate")
    .select("effective_date, rate_pct")
    .order("effective_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`한국 기준금리 최신값 조회 실패: ${error.message}`);
  if (!data) return null;
  return { effectiveDate: data.effective_date, values: [Number(data.rate_pct)] };
}

export async function upsertKrBaseRates(points: RatePoint[]): Promise<void> {
  if (points.length === 0) return;
  const { error } = await supabaseAdmin.from("kr_base_rate").upsert(
    points.map((p) => ({
      effective_date: p.effectiveDate,
      rate_pct: p.values[0],
      updated_at: new Date().toISOString(),
    }))
  );
  if (error) throw new Error(`한국 기준금리 저장 실패: ${error.message}`);
}

/** FOMC/금통위 발표 감지 재시도(scripts/check-rate-announcement.ts)의 각 시도 결과를
 * 남긴다 — "몇 번 만에 감지됐는지" 나중에 rate_check_log를 조회해 확인할 수 있게. */
export async function logRateCheckAttempt(
  market: "US" | "KR",
  offsetMin: number,
  changed: boolean,
  latest: RatePoint | null
): Promise<void> {
  const { error } = await supabaseAdmin.from("rate_check_log").insert({
    market,
    offset_min: offsetMin,
    changed,
    fetched_effective_date: latest?.effectiveDate ?? null,
    fetched_values: latest?.values ?? null,
  });
  if (error) throw new Error(`발표 감지 로그 저장 실패: ${error.message}`);
}

export interface UsFedRatePoint {
  effectiveDate: string;
  targetUpperPct: number;
  targetLowerPct: number;
}

export async function getUsFedRateHistory(): Promise<UsFedRatePoint[]> {
  const { data, error } = await supabaseAdmin
    .from("us_fed_funds_rate")
    .select("effective_date, target_upper_pct, target_lower_pct")
    .order("effective_date", { ascending: true });
  if (error) throw new Error(`미국 기준금리 이력 조회 실패: ${error.message}`);
  return (data ?? []).map((r) => ({
    effectiveDate: r.effective_date,
    targetUpperPct: Number(r.target_upper_pct),
    targetLowerPct: Number(r.target_lower_pct),
  }));
}

export interface KrBaseRatePoint {
  effectiveDate: string;
  ratePct: number;
}

export async function getKrBaseRateHistory(): Promise<KrBaseRatePoint[]> {
  const { data, error } = await supabaseAdmin
    .from("kr_base_rate")
    .select("effective_date, rate_pct")
    .order("effective_date", { ascending: true });
  if (error) throw new Error(`한국 기준금리 이력 조회 실패: ${error.message}`);
  return (data ?? []).map((r) => ({ effectiveDate: r.effective_date, ratePct: Number(r.rate_pct) }));
}
