/**
 * (임시) 급등주 찾기 v2(reversal_breakout_v2) 배포 후 실데이터 검증.
 * PR #251 병합 + 마이그레이션 적용 + screen-all-stocks 강제 1회 실행 직후,
 * 아래를 실데이터로 확인한다:
 *   1) strategies에 v2 행이 실제로 생성됐는지
 *   2) 오늘 배치로 쌓인 screening_results에서 v2 active 종목이 v1 active 종목의
 *      부분집합인지, 매칭 건수 비교
 *   3) paper_trades/paper_positions가 참조하는 screening_result가 reversal_breakout_v2
 *      전략 소속인 적이 있는지(있으면 안 됨 — paper-trade 격리 위반)
 *   4) computeScreeningResultStats가 실제 v1/v2 행에 대해 정상 값을 내는지
 *
 * 확인 후 즉시 삭제 예정(디스포저블 진단 스크립트).
 * tsx --conditions=react-server scripts/verify-reversal-breakout-v2.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { computeScreeningResultStats, type ScreeningResultStatRow } from "@/lib/screeningResultStats";

async function main(): Promise<void> {
  console.log("########## 1. strategies에서 reversal_breakout / reversal_breakout_v2 조회 ##########");
  const { data: strategies, error: strategiesError } = await supabaseAdmin
    .from("strategies")
    .select("id, user_id, name, rule_type, market")
    .in("rule_type", ["reversal_breakout", "reversal_breakout_v2"]);
  if (strategiesError) throw new Error(strategiesError.message);
  console.log(`  전체 ${strategies?.length ?? 0}건`);
  for (const s of strategies ?? []) {
    console.log(`  id=${s.id} user=${s.user_id} rule_type=${s.rule_type} market=${s.market} name=${s.name}`);
  }

  const v1Ids = (strategies ?? []).filter((s) => s.rule_type === "reversal_breakout").map((s) => s.id);
  const v2Ids = (strategies ?? []).filter((s) => s.rule_type === "reversal_breakout_v2").map((s) => s.id);
  console.log(`  v1 전략 수=${v1Ids.length} v2 전략 수=${v2Ids.length}`);

  if (v2Ids.length === 0) {
    console.log("v2 전략이 하나도 없습니다 — 마이그레이션 미적용 가능성. 이후 단계를 건너뜁니다.");
    return;
  }

  console.log("\n########## 2. screening_results: v1 vs v2 매칭 비교 (계정별) ##########");
  const { data: allResults, error: resultsError } = await supabaseAdmin
    .from("screening_results")
    .select("strategy_id, stock_code, status, return_pct, matched_at")
    .in("strategy_id", [...v1Ids, ...v2Ids]);
  if (resultsError) throw new Error(resultsError.message);
  console.log(`  전체 조회 행 수: ${allResults?.length ?? 0}`);

  const byStrategy = new Map<string, typeof allResults>();
  for (const row of allResults ?? []) {
    const list = byStrategy.get(row.strategy_id) ?? [];
    list.push(row);
    byStrategy.set(row.strategy_id, list);
  }

  // 계정(user_id)별로 v1/v2 짝을 지어 부분집합 검증(여러 계정이 각자 v1/v2를 가짐)
  const userToV1 = new Map<string, string>();
  const userToV2 = new Map<string, string>();
  for (const s of strategies ?? []) {
    if (s.rule_type === "reversal_breakout") userToV1.set(s.user_id, s.id);
    if (s.rule_type === "reversal_breakout_v2") userToV2.set(s.user_id, s.id);
  }

  let subsetViolations = 0;
  for (const [userId, v2Id] of userToV2.entries()) {
    const v1Id = userToV1.get(userId);
    const v2Rows = byStrategy.get(v2Id) ?? [];
    const v2Active = new Set(v2Rows.filter((r) => r.status === "active").map((r) => r.stock_code));
    const v1Rows = v1Id ? byStrategy.get(v1Id) ?? [] : [];
    const v1Active = new Set(v1Rows.filter((r) => r.status === "active").map((r) => r.stock_code));

    const notInV1 = [...v2Active].filter((code) => !v1Active.has(code));
    console.log(
      `  user=${userId} v1매칭(active)=${v1Active.size} v2매칭(active)=${v2Active.size} v2전체=${v2Rows.length} v1전체=${v1Rows.length} v2가v1에없는종목수=${notInV1.length}`
    );
    if (notInV1.length > 0) {
      subsetViolations++;
      console.log(`    !! 부분집합 위반 종목: ${notInV1.join(", ")}`);
    }
  }
  console.log(`  부분집합 위반 계정 수: ${subsetViolations}`);

  console.log("\n########## 3. paper-trade가 reversal_breakout_v2 신호를 참조했는지 ##########");
  const { data: paperTrades, error: paperTradesError } = await supabaseAdmin
    .from("paper_trades")
    .select("id, screening_result_id, stock_code, traded_at");
  if (paperTradesError) throw new Error(paperTradesError.message);
  const { data: paperPositions, error: paperPositionsError } = await supabaseAdmin
    .from("paper_positions")
    .select("id, screening_result_id, stock_code");
  if (paperPositionsError) throw new Error(paperPositionsError.message);

  const screeningResultIds = [
    ...new Set(
      [...(paperTrades ?? []), ...(paperPositions ?? [])]
        .map((r) => r.screening_result_id)
        .filter((id): id is string => id !== null)
    ),
  ];
  console.log(`  paper_trades=${paperTrades?.length ?? 0}건, paper_positions=${paperPositions?.length ?? 0}건, 참조하는 screening_result 고유 id=${screeningResultIds.length}건`);

  let v2LeakCount = 0;
  if (screeningResultIds.length > 0) {
    const { data: referencedResults, error: referencedError } = await supabaseAdmin
      .from("screening_results")
      .select("id, strategy_id")
      .in("id", screeningResultIds);
    if (referencedError) throw new Error(referencedError.message);
    const referencedStrategyIds = new Set((referencedResults ?? []).map((r) => r.strategy_id));
    for (const id of referencedStrategyIds) {
      if (v2Ids.includes(id)) v2LeakCount++;
    }
  }
  console.log(`  reversal_breakout_v2 전략을 참조하는 paper-trade/position 존재 여부: ${v2LeakCount > 0 ? `있음(위반, ${v2LeakCount}건 전략)` : "없음(정상)"}`);

  console.log("\n########## 4. computeScreeningResultStats 실데이터 검증 ##########");
  for (const [label, ids] of [
    ["v1(reversal_breakout)", v1Ids],
    ["v2(reversal_breakout_v2)", v2Ids],
  ] as const) {
    const rows: ScreeningResultStatRow[] = (allResults ?? [])
      .filter((r) => ids.includes(r.strategy_id))
      .map((r) => ({
        status: r.status as ScreeningResultStatRow["status"],
        returnPct: r.return_pct,
        matchedAt: r.matched_at,
      }));
    const stats = computeScreeningResultStats(rows);
    console.log(
      `  ${label}: total=${stats.total} active=${stats.activeCount} closed=${stats.closedCount} winRate=${stats.winRate === null ? "null" : (stats.winRate * 100).toFixed(2) + "%"} avg=${stats.avgReturnPct === null ? "null" : stats.avgReturnPct.toFixed(3) + "%"} median=${stats.medianReturnPct === null ? "null" : stats.medianReturnPct.toFixed(3) + "%"}`
    );
    const hasNaN =
      (stats.winRate !== null && Number.isNaN(stats.winRate)) ||
      (stats.avgReturnPct !== null && Number.isNaN(stats.avgReturnPct)) ||
      (stats.medianReturnPct !== null && Number.isNaN(stats.medianReturnPct));
    if (hasNaN) console.log(`    !! NaN 발견`);
  }

  console.log("\n=== 검증 종료 ===");
}

main().catch((error) => {
  console.error("검증 중 오류:", error);
  process.exit(1);
});
