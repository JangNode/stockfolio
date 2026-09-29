/**
 * [디스포저블 진단 스크립트, 1회성] beta_price_history(코스피/코스닥 지수 일별
 * 종가)의 실제 커버리지(가장 오래된/최신 날짜, 행 수)를 확인한다. 순수 조회만
 * 하고 아무것도 쓰지 않는다.
 *
 * "장기 백테스트" 벤치마크 비교 조사(2026-09-29)용 — 확인이 끝나면 이 스크립트와
 * 대응 워크플로(.github/workflows/diagnose-index-coverage-and-krx-availability.yml)는
 * 정리 PR로 제거한다.
 *
 * 실행: tsx --conditions=react-server scripts/diagnose-index-price-coverage.ts
 * 필요 환경변수: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import type { KrxMarket } from "@/lib/stockMaster";

const TABLE = "beta_price_history";

async function checkMarket(market: KrxMarket): Promise<void> {
  const [{ data: oldest, error: oldestError }, { data: newest, error: newestError }, { count, error: countError }] =
    await Promise.all([
      supabaseAdmin.from(TABLE).select("trade_date").eq("market", market).order("trade_date", { ascending: true }).limit(1).maybeSingle(),
      supabaseAdmin.from(TABLE).select("trade_date").eq("market", market).order("trade_date", { ascending: false }).limit(1).maybeSingle(),
      supabaseAdmin.from(TABLE).select("*", { count: "exact", head: true }).eq("market", market),
    ]);

  if (oldestError || newestError || countError) {
    console.error(
      `[${market}] 조회 실패: ${oldestError?.message ?? ""} ${newestError?.message ?? ""} ${countError?.message ?? ""}`
    );
    return;
  }

  console.log(
    `[${market}] 가장 오래된 날짜: ${oldest?.trade_date ?? "(없음)"}, 최신 날짜: ${newest?.trade_date ?? "(없음)"}, 총 ${count ?? 0}행`
  );
}

async function main(): Promise<void> {
  console.log("beta_price_history 커버리지 진단 시작");
  await checkMarket("KOSPI");
  await checkMarket("KOSDAQ");
  console.log("완료");
}

main().catch((error) => {
  console.error("진단 중 오류:", error);
  process.exit(1);
});
