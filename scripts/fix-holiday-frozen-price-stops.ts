/**
 * [디스포저블 정리 스크립트, 1회성] 2026-09-24/25(추석 연휴, KRX 실제 휴장)에
 * KIS 실시간 시세 조회가 9/23 종가 부근 값으로 동결된 상태에서 국내 스크리닝
 * 배치가 정상 거래일처럼 실행돼, 휴장 기간 이전부터 있던 active 포지션들이
 * 잘못 손절(status='stopped')되고 그중 일부는 같은 배치 안에서 곧바로 재매칭돼
 * "손절→재매칭" 사이클이 반복된 문제를 정리한다(scripts/diagnose-holiday-batch-price-impact.ts
 * 로 이미 확인: 이 기간 실제 AI 모의투자 매도(paper_trades sell)는 0건이라
 * 실거래 영향은 없음 — 순수 screening_results 이력 정정).
 *
 * 종목을 하드코딩하지 않고, (strategy_id, stock_code)별로 다음 규칙을 일반적으로
 * 적용해 대상을 찾는다:
 *   - WINDOW_START~WINDOW_END(휴장 기간, KST 9/24 00:00~9/26 00:00) 이전에 매칭된
 *     행이 이 기간 안에 status='stopped'로 전환됐다면 → 복원 대상(RESTORE:
 *     status='active', closed_at=null).
 *   - 같은 (strategy_id, stock_code)에 이 기간 안에 matched_at이 찍힌 행이 있다면
 *     → 그건 동결가로 잘못 손절된 자리에 곧바로 재매칭된 산물이므로 삭제 대상
 *     (DELETE) — 이 기간 동안은 KRX 자체가 휴장이라(stock_daily_prices_recent에
 *     9/24·25 데이터가 전혀 없음, chk-holiday로도 opnd_yn=N 확인됨) 이 기간에
 *     찍힌 매칭은 전략 종류(minervini/reversal_breakout/peg_lynch 등)를 가리지
 *     않고 전부 같은 동결된 데이터에 기반한 산물이다.
 *   - 위 두 조건이 애매한 경우(복원 대상이 0개나 2개 이상, 또는 복원 대상 없이
 *     재매칭행만 있는 경우)는 자동으로 처리하지 않고 이상 항목으로만 출력한다.
 *
 * 기본은 계획만 출력하는 드라이런이다. 실제로 DB에 반영하려면
 * FIX_HOLIDAY_STOPS_APPLY=true 환경변수를 줘야 한다.
 *
 * 필요 환경변수: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   tsx --conditions=react-server scripts/fix-holiday-frozen-price-stops.ts
 *   FIX_HOLIDAY_STOPS_APPLY=true tsx --conditions=react-server scripts/fix-holiday-frozen-price-stops.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const WINDOW_START = "2026-09-23T15:00:00Z"; // KST 2026-09-24 00:00
const WINDOW_END = "2026-09-26T00:00:00Z"; // KST 2026-09-26 09:00 (넉넉히)

interface ScreeningResultRow {
  id: string;
  strategy_id: string;
  stock_code: string;
  stock_name: string;
  status: string;
  matched_at: string;
  closed_at: string | null;
  current_price: number;
  return_pct: number;
}

async function main(): Promise<void> {
  const apply = process.env.FIX_HOLIDAY_STOPS_APPLY === "true";
  console.log(apply ? "*** APPLY 모드: 실제로 DB를 수정합니다 ***" : "드라이런 모드(계획만 출력, DB 미수정)");

  // 이 기간에 "손절됨" 또는 "이 기간 안에 새로 매칭됨" 둘 중 하나라도 해당하는 국내 행을 전부 모은다.
  const { data: stoppedInWindow, error: stoppedErr } = await supabaseAdmin
    .from("screening_results")
    .select("id, strategy_id, stock_code, stock_name, status, matched_at, closed_at, current_price, return_pct")
    .eq("market", "KR")
    .eq("status", "stopped")
    .gte("closed_at", WINDOW_START)
    .lte("closed_at", WINDOW_END);
  if (stoppedErr) throw new Error(`stopped 조회 실패: ${stoppedErr.message}`);

  const { data: matchedInWindow, error: matchedErr } = await supabaseAdmin
    .from("screening_results")
    .select("id, strategy_id, stock_code, stock_name, status, matched_at, closed_at, current_price, return_pct")
    .eq("market", "KR")
    .gte("matched_at", WINDOW_START)
    .lte("matched_at", WINDOW_END);
  if (matchedErr) throw new Error(`matched 조회 실패: ${matchedErr.message}`);

  console.log(`이 기간 stopped(closed_at 기준) 행: ${stoppedInWindow?.length ?? 0}건`);
  console.log(`이 기간 matched_at이 찍힌 행: ${matchedInWindow?.length ?? 0}건`);

  // 관련된 (strategy_id, stock_code) 쌍 전체의 전체 이력을 다시 가져온다(그룹별 판단을 위해).
  const pairKeys = new Set<string>();
  for (const r of [...(stoppedInWindow ?? []), ...(matchedInWindow ?? [])]) {
    pairKeys.add(`${r.strategy_id}::${r.stock_code}`);
  }

  const groups = new Map<string, ScreeningResultRow[]>();
  for (const key of pairKeys) {
    const [strategyId, stockCode] = key.split("::");
    const { data, error } = await supabaseAdmin
      .from("screening_results")
      .select("id, strategy_id, stock_code, stock_name, status, matched_at, closed_at, current_price, return_pct")
      .eq("market", "KR")
      .eq("strategy_id", strategyId)
      .eq("stock_code", stockCode)
      .order("matched_at", { ascending: true });
    if (error) throw new Error(`그룹 조회 실패(${key}): ${error.message}`);
    groups.set(key, data ?? []);
  }

  const toRestore: ScreeningResultRow[] = [];
  const toDelete: ScreeningResultRow[] = [];
  const anomalies: { key: string; reason: string; rows: ScreeningResultRow[] }[] = [];

  for (const [key, rows] of groups) {
    const preWindow = rows.filter((r) => r.matched_at < WINDOW_START);
    const inWindow = rows.filter((r) => r.matched_at >= WINDOW_START && r.matched_at <= WINDOW_END);
    const restoreCandidates = preWindow.filter(
      (r) => r.status === "stopped" && r.closed_at !== null && r.closed_at >= WINDOW_START && r.closed_at <= WINDOW_END
    );

    if (restoreCandidates.length === 1) {
      toRestore.push(restoreCandidates[0]);
      toDelete.push(...inWindow);
    } else if (restoreCandidates.length === 0 && inWindow.length > 0) {
      anomalies.push({ key, reason: "복원 대상(휴장 이전 매칭·이 기간 중 손절) 없이 이 기간 매칭행만 존재", rows });
    } else if (restoreCandidates.length > 1) {
      anomalies.push({ key, reason: "복원 대상이 2개 이상(중복)", rows });
    } else {
      anomalies.push({ key, reason: "분류 불가(예상치 못한 조합)", rows });
    }
  }

  console.log(`\n=== 계획: 복원(RESTORE) ${toRestore.length}건 ===`);
  for (const r of toRestore) {
    console.log(
      `  ${r.stock_code} ${r.stock_name} id=${r.id} matched_at=${r.matched_at} closed_at=${r.closed_at} -> status=active, closed_at=null`
    );
  }

  console.log(`\n=== 계획: 삭제(DELETE, 재매칭 산물) ${toDelete.length}건 ===`);
  for (const r of toDelete) {
    console.log(`  ${r.stock_code} ${r.stock_name} id=${r.id} status=${r.status} matched_at=${r.matched_at} closed_at=${r.closed_at}`);
  }

  console.log(`\n=== 이상 항목(자동 처리 안 함) ${anomalies.length}건 ===`);
  for (const a of anomalies) {
    console.log(`  [${a.key}] ${a.reason}`);
    console.log(JSON.stringify(a.rows, null, 2));
  }

  const restoredIdsSet = new Set(toRestore.map((r) => r.id));
  const totalStoppedHandled = (stoppedInWindow ?? []).filter((r) => restoredIdsSet.has(r.id)).length;
  console.log(
    `\n요약: 이 기간 stopped ${stoppedInWindow?.length ?? 0}건 중 ${totalStoppedHandled}건을 복원 계획에 포함, ` +
      `나머지 ${(stoppedInWindow?.length ?? 0) - totalStoppedHandled}건은 이상 항목으로 분류됨.`
  );

  if (!apply) {
    console.log("\n드라이런 종료 — 실제 반영 없음. FIX_HOLIDAY_STOPS_APPLY=true로 재실행하면 반영됩니다.");
    return;
  }

  if (anomalies.length > 0) {
    console.error("\n이상 항목이 있어 안전을 위해 APPLY를 중단합니다. 이상 항목을 먼저 확인하세요.");
    process.exit(1);
  }

  for (const r of toRestore) {
    const { error } = await supabaseAdmin
      .from("screening_results")
      .update({ status: "active", closed_at: null })
      .eq("id", r.id);
    if (error) throw new Error(`복원 실패(id=${r.id}): ${error.message}`);
  }
  console.log(`복원 완료: ${toRestore.length}건`);

  if (toDelete.length > 0) {
    const { error } = await supabaseAdmin
      .from("screening_results")
      .delete()
      .in("id", toDelete.map((r) => r.id));
    if (error) throw new Error(`삭제 실패: ${error.message}`);
  }
  console.log(`삭제 완료: ${toDelete.length}건`);
}

main().catch((error) => {
  console.error("정리 스크립트 중 오류:", error);
  process.exit(1);
});
