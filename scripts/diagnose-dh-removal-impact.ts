/**
 * DH전략(dh_value_dividend) 완전 제거 전 실측 확인용 디스포저블 진단 스크립트.
 * 읽기 전용(SELECT만) — 아무것도 지우거나 바꾸지 않는다. 확인 후 삭제 예정.
 *
 * 확인 항목:
 * 1) strategies 중 rule_type='dh_value_dividend' 행 수(계정 수).
 * 2) 그 전략들에 딸린 screening_results 행 수(status별 분포 포함).
 * 3) paper_positions.screening_result_id가 그 screening_results를 가리키는 행 수
 *    (schema.sql: ON DELETE 지정 없음 → cascade 삭제 시 FK 위반으로 막힐 수 있음).
 * 4) paper_trades.screening_result_id가 그 screening_results를 가리키는 행 수(동일 이유).
 *
 *   npx tsx --conditions=react-server scripts/diagnose-dh-removal-impact.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";

async function main(): Promise<void> {
  const { data: dhStrategies, error: strategiesError } = await supabaseAdmin
    .from("strategies")
    .select("id")
    .eq("rule_type", "dh_value_dividend");
  if (strategiesError) throw new Error(`strategies 조회 실패: ${strategiesError.message}`);

  const strategyIds = (dhStrategies ?? []).map((s) => s.id);
  console.log(`1) dh_value_dividend strategies 행 수: ${strategyIds.length}`);

  if (strategyIds.length === 0) {
    console.log("dh_value_dividend 전략이 없습니다 — 이후 확인은 모두 0건입니다.");
    return;
  }

  const { data: results, error: resultsError, count: resultsCount } = await supabaseAdmin
    .from("screening_results")
    .select("id, status", { count: "exact" })
    .in("strategy_id", strategyIds);
  if (resultsError) throw new Error(`screening_results 조회 실패: ${resultsError.message}`);

  const statusCounts = new Map<string, number>();
  for (const r of results ?? []) {
    statusCounts.set(r.status, (statusCounts.get(r.status) ?? 0) + 1);
  }
  console.log(`2) 딸린 screening_results 행 수: ${resultsCount ?? results?.length ?? 0}`);
  for (const [status, n] of statusCounts) {
    console.log(`   - status=${status}: ${n}건`);
  }

  const resultIds = (results ?? []).map((r) => r.id);
  if (resultIds.length === 0) {
    console.log("screening_results가 없어 paper_positions/paper_trades 참조 확인을 건너뜁니다.");
    return;
  }

  // Postgres in() 절 길이 제한을 피하려고 1000개씩 나눠 조회한다.
  const CHUNK = 1000;
  let positionRefCount = 0;
  let tradeRefCount = 0;
  for (let i = 0; i < resultIds.length; i += CHUNK) {
    const chunk = resultIds.slice(i, i + CHUNK);

    const { count: posCount, error: posError } = await supabaseAdmin
      .from("paper_positions")
      .select("id", { count: "exact", head: true })
      .in("screening_result_id", chunk);
    if (posError) throw new Error(`paper_positions 조회 실패: ${posError.message}`);
    positionRefCount += posCount ?? 0;

    const { count: tradeCount, error: tradeError } = await supabaseAdmin
      .from("paper_trades")
      .select("id", { count: "exact", head: true })
      .in("screening_result_id", chunk);
    if (tradeError) throw new Error(`paper_trades 조회 실패: ${tradeError.message}`);
    tradeRefCount += tradeCount ?? 0;
  }

  console.log(`3) paper_positions.screening_result_id가 DH screening_results를 가리키는 행 수: ${positionRefCount}`);
  console.log(`4) paper_trades.screening_result_id가 DH screening_results를 가리키는 행 수: ${tradeRefCount}`);

  if (positionRefCount > 0 || tradeRefCount > 0) {
    console.log(
      "경고: paper_positions/paper_trades가 DH screening_results를 참조 중입니다. " +
        "screening_results를 cascade 삭제하기 전에 이 FK를 ON DELETE SET NULL로 바꾸지 않으면 " +
        "삭제 트랜잭션이 FK 위반으로 실패합니다."
    );
  } else {
    console.log("paper_positions/paper_trades 참조 없음 — 단순 cascade 삭제로 안전합니다.");
  }
}

main().catch((error) => {
  console.error("진단 스크립트 실행 중 오류:", error);
  process.exit(1);
});
