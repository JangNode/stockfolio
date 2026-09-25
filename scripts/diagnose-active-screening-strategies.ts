/**
 * [디스포저블 진단 스크립트] "급등주 찾기 v1 vs v2 비교" 카드를 전체 전략
 * 비교로 일반화하기 전, strategies 테이블에 실제로 존재하는 rule_type과
 * 각각의 screening_results 신호 수(전체/추적중/종료)를 확인한다. DB
 * 쓰기 없음(순수 조회).
 *
 * 필요 환경변수: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   tsx --conditions=react-server scripts/diagnose-active-screening-strategies.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";

async function main(): Promise<void> {
  const { data: strategies, error: strategiesError } = await supabaseAdmin
    .from("strategies")
    .select("id, user_id, name, rule_type, market, created_at")
    .order("rule_type", { ascending: true });
  if (strategiesError) throw new Error(`strategies 조회 실패: ${strategiesError.message}`);

  console.log(`strategies 총 ${strategies?.length ?? 0}건`);

  const byRuleType = new Map<string, typeof strategies>();
  for (const s of strategies ?? []) {
    const key = `${s.rule_type}::${s.market}`;
    const list = byRuleType.get(key) ?? [];
    list.push(s);
    byRuleType.set(key, list);
  }

  for (const [key, list] of [...byRuleType.entries()].sort()) {
    console.log(`\n=== ${key}: ${list.length}건 ===`);
    console.log(list.map((s) => `  id=${s.id} user_id=${s.user_id} name=${s.name} created_at=${s.created_at}`).join("\n"));
  }

  console.log("\n\n=== rule_type별 screening_results 신호 수(전체/active/stopped/profited/price_unavailable) ===");
  for (const [key, list] of [...byRuleType.entries()].sort()) {
    const ids = list.map((s) => s.id);
    const { data: results, error: resultsError } = await supabaseAdmin
      .from("screening_results")
      .select("status")
      .in("strategy_id", ids);
    if (resultsError) throw new Error(`screening_results 조회 실패(${key}): ${resultsError.message}`);

    const counts: Record<string, number> = {};
    for (const r of results ?? []) counts[r.status] = (counts[r.status] ?? 0) + 1;
    const closed = (counts["stopped"] ?? 0) + (counts["profited"] ?? 0);
    console.log(
      `${key}: 전체=${results?.length ?? 0}, active=${counts["active"] ?? 0}, ` +
        `stopped=${counts["stopped"] ?? 0}, profited=${counts["profited"] ?? 0}, ` +
        `price_unavailable=${counts["price_unavailable"] ?? 0}, 종료(stopped+profited)=${closed}`
    );
  }
}

main().catch((error) => {
  console.error("진단 중 오류:", error);
  process.exit(1);
});
