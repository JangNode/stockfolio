import "server-only";
import { parquetReadObjects } from "hyparquet";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { isExcludedStock, selectMembers } from "@/lib/marketRegime";
import { candidatesOn, type PriceBook } from "@/lib/marketRegimeCompute";
import { PIT_MIN_AVG_TRADING_VALUE_WON } from "@/lib/strategyBacktestSummaryConfig";
import { REGIME_TOP_N, REGIME_BACKFILL_MEMBERSHIP_BUCKET, REGIME_BACKFILL_MEMBERSHIP_PATH } from "@/lib/marketRegimeConfig";

/** 상위 200 구성 종목: 후보(그날 가격 행) 중 코스피 ∩ 20일 평균 거래대금 ≥ 5억 ∩ 제외 규칙 통과, 시총 상위 REGIME_TOP_N. */
export function membersOnDate(book: PriceBook, date: string, isKospi: (code: string) => boolean, isExcluded: (code: string) => boolean): string[] {
  return selectMembers(candidatesOn(book, date, isKospi, isExcluded), REGIME_TOP_N, PIT_MIN_AVG_TRADING_VALUE_WON);
}

/** 코드 → 제외 여부(결과를 코드별로 캐시). names·ksic·productTypes는 경로에 맞는 출처(백필: DB 표, 일일: KIS 종목마스터)에서 가져온다. */
export function makeExcluder(names: Map<string, string>, ksic: Map<string, string>, productTypes?: Map<string, string>): (code: string) => boolean {
  const cache = new Map<string, boolean>();
  return (code) => {
    let v = cache.get(code);
    if (v === undefined) { v = isExcludedStock({ code, name: names.get(code), ksic: ksic.get(code), productType: productTypes?.get(code) }); cache.set(code, v); }
    return v;
  };
}

/**
 * [백필 전용] 월말 시장 구분 목록(연구용 수집 파일)을 한 번 읽어 월말 날짜 → KOSPI 종목코드 집합으로 만든다. 읽기 전용.
 * 파일이 없으면 던진다 — 운영 일일 배치는 이 함수를 쓰지 않는다.
 */
export async function loadMonthEndKospi(): Promise<Map<string, Set<string>>> {
  const dl = await supabaseAdmin.storage.from(REGIME_BACKFILL_MEMBERSHIP_BUCKET).download(REGIME_BACKFILL_MEMBERSHIP_PATH);
  if (dl.error || !dl.data) throw new Error(`${REGIME_BACKFILL_MEMBERSHIP_PATH} 읽기 실패: ${dl.error?.message ?? "파일 없음"}`);
  const rows = (await parquetReadObjects({ file: await dl.data.arrayBuffer() })) as { trade_date: string; stock_code: string; market: string }[];
  const out = new Map<string, Set<string>>();
  for (const r of rows) {
    if (r.market !== "KOSPI") continue;
    let s = out.get(r.trade_date);
    if (!s) { s = new Set(); out.set(r.trade_date, s); }
    s.add(r.stock_code);
  }
  return out;
}

/** date 이하 가장 최근 월말의 KOSPI 집합을 찾는 함수(월말 날짜 오름차순 이진 탐색). 해당 월말이 없으면 빈 집합. */
export function monthEndLookup(byMonthEnd: Map<string, Set<string>>): (date: string) => Set<string> {
  const keys = [...byMonthEnd.keys()].sort();
  return (date) => {
    let lo = 0, hi = keys.length - 1, k = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (keys[m] <= date) { k = m; lo = m + 1; } else hi = m - 1; }
    return k >= 0 ? byMonthEnd.get(keys[k])! : new Set<string>();
  };
}
