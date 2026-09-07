/**
 * (임시) 급등주 찾기 진입가 버그 수정 + 3차에 걸친 리플레이 보정 완료 후 최종 확인.
 * 읽기 전용 — computeScreeningResultStats로 v1/v2 계정 합산 실적을 다시 계산해
 * 승률 0% 왜곡이 해소됐는지 확인한다. 확인 후 즉시 삭제 예정.
 * tsx --conditions=react-server scripts/verify-reversal-breakout-final-stats.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { computeScreeningResultStats, type ScreeningResultStatRow } from "@/lib/screeningResultStats";

async function main(): Promise<void> {
  const { data: strategies, error: strategiesError } = await supabaseAdmin
    .from("strategies")
    .select("id, rule_type")
    .in("rule_type", ["reversal_breakout", "reversal_breakout_v2"]);
  if (strategiesError) throw new Error(strategiesError.message);

  const v1Ids = (strategies ?? []).filter((s) => s.rule_type === "reversal_breakout").map((s) => s.id);
  const v2Ids = (strategies ?? []).filter((s) => s.rule_type === "reversal_breakout_v2").map((s) => s.id);

  const { data: results, error: resultsError } = await supabaseAdmin
    .from("screening_results")
    .select("strategy_id, status, return_pct, matched_at")
    .in("strategy_id", [...v1Ids, ...v2Ids]);
  if (resultsError) throw new Error(resultsError.message);

  for (const [label, ids] of [
    ["v1(reversal_breakout)", v1Ids],
    ["v2(reversal_breakout_v2)", v2Ids],
  ] as const) {
    const rows: ScreeningResultStatRow[] = (results ?? [])
      .filter((r) => ids.includes(r.strategy_id))
      .map((r) => ({ status: r.status as ScreeningResultStatRow["status"], returnPct: r.return_pct, matchedAt: r.matched_at }));
    const stats = computeScreeningResultStats(rows);
    console.log(
      `${label}: total=${stats.total} active=${stats.activeCount} closed=${stats.closedCount} winRate=${stats.winRate === null ? "null" : (stats.winRate * 100).toFixed(2) + "%"} avg=${stats.avgReturnPct === null ? "null" : stats.avgReturnPct.toFixed(3) + "%"} median=${stats.medianReturnPct === null ? "null" : stats.medianReturnPct.toFixed(3) + "%"}`
    );
  }

  // 아직 상태가 왜곡된 채 남아있는 게 있는지 마지막으로 확인: closed인데 return_pct가
  // entry_price=signal_price 기준 손절/익절 임계값(대략 -7%/+20%, 계정별 rule_params가
  // 없으면 기본값)과 크게 동떨어진 이상치가 있는지도 살펴본다(참고용, 자동 판정 아님).
  const closedV1 = (results ?? []).filter((r) => v1Ids.includes(r.strategy_id) && r.status !== "active");
  const extreme = closedV1.filter((r) => r.return_pct < -30 || r.return_pct > 40);
  console.log(`v1 closed 중 return_pct가 -30% 미만/+40% 초과인 이상치: ${extreme.length}건`);
  for (const r of extreme.slice(0, 20)) {
    console.log(`  strategy_id=${r.strategy_id} status=${r.status} return_pct=${r.return_pct.toFixed(2)}% matched_at=${r.matched_at}`);
  }
}

main().catch((error) => {
  console.error("검증 중 오류:", error);
  process.exit(1);
});
