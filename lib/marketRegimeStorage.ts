import "server-only";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import type { Regime } from "@/lib/marketRegime";
import type { RegimeRow, RegimeSource } from "@/lib/marketRegimeCompute";
import { REGIME_STATUS_SOURCE } from "@/lib/marketRegimeConfig";

const TABLE = "market_regime_daily";
const PAGE_SIZE = 1000;
const UPSERT_BATCH = 500;
const COLUMNS = "trade_date, regime, raw_regime, kospi_close, ma50, ma200, b50, b200, nh, drawdown, vol20, vol_pctile, member_count, source";

interface DbRow {
  trade_date: string; regime: Regime; raw_regime: Regime; kospi_close: number | string;
  ma50: number | string | null; ma200: number | string | null; b50: number | string | null; b200: number | string | null; nh: number | null;
  drawdown: number | string | null; vol20: number | string | null; vol_pctile: number | string | null; member_count: number; source: RegimeSource;
}
const num = (v: number | string | null): number | null => (v === null ? null : Number(v));

function fromDb(r: DbRow): RegimeRow {
  return {
    tradeDate: r.trade_date, regime: r.regime, rawRegime: r.raw_regime, kospiClose: Number(r.kospi_close), ma50: num(r.ma50), ma200: num(r.ma200),
    b50: num(r.b50), b200: num(r.b200), nh: r.nh, drawdown: num(r.drawdown), vol20: num(r.vol20), volPctile: num(r.vol_pctile),
    memberCount: r.member_count, source: r.source,
  };
}

export function toDbRow(r: RegimeRow): DbRow {
  return {
    trade_date: r.tradeDate, regime: r.regime, raw_regime: r.rawRegime, kospi_close: r.kospiClose, ma50: r.ma50, ma200: r.ma200, b50: r.b50, b200: r.b200,
    nh: r.nh, drawdown: r.drawdown, vol20: r.vol20, vol_pctile: r.volPctile, member_count: r.memberCount, source: r.source,
  };
}

export async function upsertRegimeRows(rows: RegimeRow[]): Promise<void> {
  for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
    const { error } = await supabaseAdmin.from(TABLE).upsert(rows.slice(i, i + UPSERT_BATCH).map(toDbRow));
    if (error) throw new Error(`시장 국면 저장 실패: ${error.message}`);
  }
}

/** 이미 있는 날짜는 건드리지 않고 없는 날짜만 넣는다(on conflict do nothing) — 이력 백필이 일일 배치 행을 덮어쓰지 않도록. */
export async function insertRegimeRowsIgnoreConflicts(rows: RegimeRow[]): Promise<void> {
  for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
    const { error } = await supabaseAdmin.from(TABLE).upsert(rows.slice(i, i + UPSERT_BATCH).map(toDbRow), { onConflict: "trade_date", ignoreDuplicates: true });
    if (error) throw new Error(`시장 국면 백필 저장 실패: ${error.message}`);
  }
}

/** source='daily' 행 중 가장 이른 날짜(없으면 null) — 백필이 이 날 앞에서 멈추는 기준. */
export async function getFirstDailyDate(): Promise<string | null> {
  const { data, error } = await supabaseAdmin.from(TABLE).select("trade_date").eq("source", "daily").order("trade_date", { ascending: true }).limit(1);
  if (error) throw new Error(`시장 국면 일일 행 조회 실패: ${error.message}`);
  return data && data.length > 0 ? (data[0].trade_date as string) : null;
}

/** 최근 n행(날짜 내림차순으로 읽어 오름차순으로 돌려준다). */
export async function getLatestRegimeRows(n: number): Promise<RegimeRow[]> {
  const { data, error } = await supabaseAdmin.from(TABLE).select(COLUMNS).order("trade_date", { ascending: false }).limit(n);
  if (error) throw new Error(`시장 국면 조회 실패: ${error.message}`);
  return ((data ?? []) as DbRow[]).map(fromDb).reverse();
}

/** 전체 이력(날짜 오름차순). PostgREST 최대 행 수 때문에 페이지네이션한다. */
export async function getAllRegimeRows(): Promise<RegimeRow[]> {
  const out: RegimeRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabaseAdmin.from(TABLE).select(COLUMNS).order("trade_date", { ascending: true }).range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`시장 국면 조회 실패: ${error.message}`);
    out.push(...((data ?? []) as DbRow[]).map(fromDb));
    if (!data || data.length < PAGE_SIZE) break;
  }
  return out;
}

/** 계산 시도마다 성공/실패를 남긴다(schedule_scrape_status의 'MARKET_REGIME' 행). 실패해도 market_regime_daily는 건드리지 않는다. */
export async function recordRegimeAttempt(errorMessage: string | null, savedRows: number | null): Promise<void> {
  const now = new Date().toISOString();
  const update: Record<string, unknown> = { source: REGIME_STATUS_SOURCE, last_attempt_at: now };
  if (errorMessage) {
    update.last_error = errorMessage;
  } else {
    update.last_error = null;
    update.last_success_at = now;
    update.last_meeting_count = savedRows;
  }
  const { error } = await supabaseAdmin.from("schedule_scrape_status").upsert(update);
  if (error) throw new Error(`시장 국면 상태 기록 실패: ${error.message}`);
}

export async function getRegimeStatus(): Promise<{ lastSuccessAt: string | null; lastError: string | null; lastAttemptAt: string | null }> {
  const { data } = await supabaseAdmin.from("schedule_scrape_status").select("last_attempt_at, last_success_at, last_error").eq("source", REGIME_STATUS_SOURCE).maybeSingle();
  return { lastAttemptAt: data?.last_attempt_at ?? null, lastSuccessAt: data?.last_success_at ?? null, lastError: data?.last_error ?? null };
}
