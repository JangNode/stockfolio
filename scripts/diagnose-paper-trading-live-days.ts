/**
 * [디스포저블 진단 스크립트] 포트폴리오 MDD 분석 3단계 — AI 모의투자(안정형/공격형/
 * 급등주/커스텀) 라이브 데이터가 실제로 며칠치 쌓여 있는지 확인한다. paper_daily_snapshots
 * (포트폴리오별 일별 평가금액 스냅샷, 매매 유무와 무관하게 매일 한 행씩 쌓임)를 스타일별로
 * 집계해 실제 활성 거래일수·기간을 뽑고, custom 스타일에 실제 채택(adopt)된 활성 전략이
 * 있는지 확인한다. DB 쓰기 없음(순수 조회).
 *
 * 필요 환경변수: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   tsx --conditions=react-server scripts/diagnose-paper-trading-live-days.ts
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";

async function main(): Promise<void> {
  const { data: portfolios, error: portfoliosError } = await supabaseAdmin
    .from("paper_portfolios")
    .select("id, style, market")
    .order("style", { ascending: true });
  if (portfoliosError) throw new Error(`paper_portfolios 조회 실패: ${portfoliosError.message}`);

  console.log("=== 스타일별 라이브 거래일수(paper_daily_snapshots 기준) ===");
  for (const portfolio of portfolios ?? []) {
    const { data: snapshots, error } = await supabaseAdmin
      .from("paper_daily_snapshots")
      .select("snapshot_date")
      .eq("portfolio_id", portfolio.id)
      .order("snapshot_date", { ascending: true });
    if (error) {
      throw new Error(`${portfolio.style}(${portfolio.market}) 스냅샷 조회 실패: ${error.message}`);
    }

    const dates = (snapshots ?? []).map((s) => s.snapshot_date as string);
    if (dates.length === 0) {
      console.log(`  ${portfolio.style}(${portfolio.market}): 스냅샷 0건 — 라이브 데이터 없음`);
      continue;
    }
    console.log(
      `  ${portfolio.style}(${portfolio.market}): ${dates.length}일 (${dates[0]} ~ ${dates[dates.length - 1]})`
    );
  }

  console.log("\n=== custom 스타일 채택(adopt) 여부 확인 ===");
  const { data: customStrategies, error: customError } = await supabaseAdmin
    .from("paper_strategies")
    .select("id, market, version, label, is_active, created_at")
    .eq("style", "custom")
    .order("created_at", { ascending: true });
  if (customError) throw new Error(`custom 전략 조회 실패: ${customError.message}`);

  if (!customStrategies || customStrategies.length === 0) {
    console.log("  custom 스타일 전략 행이 아예 없습니다 — 실험실에서 채택된 적 없음.");
  } else {
    for (const s of customStrategies) {
      console.log(`  [${s.market}] v${s.version} "${s.label}" (활성: ${s.is_active}, 생성: ${s.created_at})`);
    }
  }
}

main().catch((error) => {
  console.error("진단 중 오류:", error);
  process.exit(1);
});
