/**
 * 디스포저블 검증 스크립트 — Cowork 시장 브리핑 웹훅 수집 기능(PR #293)의 DB
 * 레이어(lib/marketBriefingStorage.ts)가 실제 프로덕션 Supabase에서 기대대로
 * 동작하는지 확인한다. 검증이 끝나면 스스로 만든 테스트 행을 전부 지운다
 * (finally에서 정리 — 성공/실패 무관).
 *
 * 검증 대상:
 *   1. upsertMarketBriefing()으로 저장한 raw_json이 그대로 읽히는지
 *   2. 같은 date_kst로 다시 upsert하면 실제로 덮어써지는지(UPSERT 동작)
 *   3. deleteOldMarketBriefings()가 RETENTION_DAYS(365일) cutoff보다 오래된
 *      행만 지우고, 그렇지 않은 행은 남겨두는지
 *   4. cowork_webhook_calls insert + 레이트리밋 카운트 쿼리(라우트가 쓰는 것과
 *      동일한 .gt("called_at", since) 패턴)가 기대대로 동작하는지
 *
 * 날짜 선택 근거: deleteOldMarketBriefings()의 cutoff는 "오늘 - 365일"이라,
 * 과거 날짜(예: 1999-01-01)는 cutoff보다 훨씬 이전이라 "살아남아야 하는 행"
 * 테스트로 쓸 수 없다(그 날짜도 지워지는 게 정상 동작이다). 그래서 cutoff보다
 * 확실히 최근인 "살아남는 행"은 먼 미래 날짜(2999-01-01)를 쓴다 — 실제 Cowork
 * 웹훅은 항상 당일 날짜만 보내므로 미래 날짜는 실데이터와 절대 충돌하지 않는,
 * 명확한 테스트 마커다.
 *
 * 필요 환경변수: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   npx tsx --conditions=react-server scripts/verify-market-briefings.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { upsertMarketBriefing, deleteOldMarketBriefings } from "@/lib/marketBriefingStorage";

// cutoff(오늘 - 365일)보다 확실히 이후라 deleteOldMarketBriefings() 이후에도
// 남아있어야 하는 테스트 행. 실제 웹훅은 절대 미래 날짜를 보내지 않으므로
// 프로덕션 데이터와 충돌하지 않는다.
const KEEP_DATE_KST = "2999-01-01";
// cutoff보다 확실히 이전이라 deleteOldMarketBriefings() 이후 지워져야 하는
// 테스트 행.
const OLD_DATE_KST = "1990-01-01";

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, sortKeysDeep(v)]));
  }
  return value;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortKeysDeep(a)) === JSON.stringify(sortKeysDeep(b));
}

function fail(message: string): never {
  throw new Error(message);
}

async function getBriefingByDate(dateKst: string): Promise<{ raw_json: unknown } | null> {
  const { data, error } = await supabaseAdmin
    .from("market_briefings")
    .select("raw_json")
    .eq("date_kst", dateKst)
    .maybeSingle();
  if (error) fail(`market_briefings 조회 실패(${dateKst}): ${error.message}`);
  return data;
}

async function cleanup(webhookCallIds: number[]): Promise<void> {
  console.log("\n정리 시작: 테스트 행 삭제 중...");

  const { error: briefingDeleteError } = await supabaseAdmin
    .from("market_briefings")
    .delete()
    .in("date_kst", [KEEP_DATE_KST, OLD_DATE_KST]);
  if (briefingDeleteError) {
    console.error(`  market_briefings 테스트 행 정리 실패: ${briefingDeleteError.message}`);
  } else {
    console.log(`  market_briefings에서 date_kst in (${KEEP_DATE_KST}, ${OLD_DATE_KST}) 삭제 완료`);
  }

  if (webhookCallIds.length > 0) {
    const { error: callsDeleteError } = await supabaseAdmin
      .from("cowork_webhook_calls")
      .delete()
      .in("id", webhookCallIds);
    if (callsDeleteError) {
      console.error(`  cowork_webhook_calls 테스트 행 정리 실패: ${callsDeleteError.message}`);
    } else {
      console.log(`  cowork_webhook_calls에서 id in (${webhookCallIds.join(", ")}) 삭제 완료`);
    }
  }
}

async function main(): Promise<void> {
  const webhookCallIds: number[] = [];

  try {
    // 1. upsert 후 읽어서 raw_json 일치 확인
    console.log("[1] upsertMarketBriefing 최초 저장 확인");
    const firstPayload = {
      meta: { date_kst: KEEP_DATE_KST, source: "verify-script" },
      indices: { kospi: 1234.5, nasdaq: 6789.1 },
      marker: "first",
    };
    const { dateKst: firstDateKst } = await upsertMarketBriefing(firstPayload);
    if (firstDateKst !== KEEP_DATE_KST) {
      fail(`upsertMarketBriefing이 반환한 dateKst가 다름: 기대=${KEEP_DATE_KST}, 실제=${firstDateKst}`);
    }
    const firstRow = await getBriefingByDate(KEEP_DATE_KST);
    if (!firstRow) fail(`저장 직후 market_briefings에서 ${KEEP_DATE_KST} 행을 찾지 못함`);
    if (!deepEqual(firstRow.raw_json, firstPayload)) {
      fail(
        `저장된 raw_json이 입력과 다름.\n입력: ${JSON.stringify(firstPayload)}\n저장됨: ${JSON.stringify(firstRow.raw_json)}`
      );
    }
    console.log("  OK: 저장된 raw_json이 입력과 일치함");

    // 2. 같은 date_kst로 다시 upsert -> 덮어쓰기 확인
    console.log("[2] 같은 date_kst 재upsert 시 덮어쓰기 확인");
    const secondPayload = {
      meta: { date_kst: KEEP_DATE_KST, source: "verify-script" },
      indices: { kospi: 9999.9, nasdaq: 1111.1 },
      marker: "second",
    };
    await upsertMarketBriefing(secondPayload);
    const secondRow = await getBriefingByDate(KEEP_DATE_KST);
    if (!secondRow) fail(`재upsert 후 market_briefings에서 ${KEEP_DATE_KST} 행을 찾지 못함`);
    if (!deepEqual(secondRow.raw_json, secondPayload)) {
      fail(
        `재upsert 후 raw_json이 덮어써지지 않음(기존 값이 남아있을 가능성).\n기대: ${JSON.stringify(secondPayload)}\n실제: ${JSON.stringify(secondRow.raw_json)}`
      );
    }
    if (deepEqual(secondRow.raw_json, firstPayload)) {
      fail("재upsert 후에도 이전 raw_json 그대로임 — UPSERT가 아니라 무시(ignore)되고 있을 가능성");
    }
    console.log("  OK: 같은 date_kst 재upsert 시 raw_json이 실제로 덮어써짐(UPSERT 동작 확인)");

    // 3. 보관 기간(365일) cutoff 이전 행 삽입 후 deleteOldMarketBriefings() 동작 확인
    console.log("[3] deleteOldMarketBriefings() cutoff 동작 확인");
    const oldPayload = {
      meta: { date_kst: OLD_DATE_KST, source: "verify-script" },
      indices: { kospi: 1.0 },
      marker: "old",
    };
    await upsertMarketBriefing(oldPayload);
    const oldRowBeforeDelete = await getBriefingByDate(OLD_DATE_KST);
    if (!oldRowBeforeDelete) fail(`오래된 테스트 행(${OLD_DATE_KST}) 삽입 직후 조회 실패`);
    console.log(`  ${OLD_DATE_KST} 테스트 행 삽입 확인됨, deleteOldMarketBriefings() 호출...`);

    await deleteOldMarketBriefings();

    const oldRowAfterDelete = await getBriefingByDate(OLD_DATE_KST);
    if (oldRowAfterDelete) {
      fail(`deleteOldMarketBriefings() 이후에도 cutoff보다 오래된 ${OLD_DATE_KST} 행이 남아있음 — 삭제 로직 오류`);
    }
    console.log(`  OK: cutoff보다 오래된 ${OLD_DATE_KST} 행이 삭제됨`);

    const keepRowAfterDelete = await getBriefingByDate(KEEP_DATE_KST);
    if (!keepRowAfterDelete) {
      fail(`deleteOldMarketBriefings()가 cutoff보다 최근인 ${KEEP_DATE_KST} 행까지 지워버림 — cutoff 계산 오류`);
    }
    if (!deepEqual(keepRowAfterDelete.raw_json, secondPayload)) {
      fail(`deleteOldMarketBriefings() 이후 ${KEEP_DATE_KST} 행의 raw_json이 예상과 다름(의도치 않게 변경됨)`);
    }
    console.log(`  OK: cutoff보다 최근인 ${KEEP_DATE_KST} 행은 그대로 남아있음`);

    // 4. cowork_webhook_calls insert + 레이트리밋 카운트 쿼리 확인
    console.log("[4] cowork_webhook_calls insert + 카운트 쿼리 확인");
    const { count: rawCountBefore, error: countBeforeError } = await supabaseAdmin
      .from("cowork_webhook_calls")
      .select("id", { count: "exact", head: true })
      .gt("called_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
    if (countBeforeError) fail(`레이트리밋 카운트 쿼리(삽입 전) 실패: ${countBeforeError.message}`);

    const { data: insertedCall, error: insertError } = await supabaseAdmin
      .from("cowork_webhook_calls")
      .insert({})
      .select("id")
      .single();
    if (insertError) fail(`cowork_webhook_calls insert 실패: ${insertError.message}`);
    if (!insertedCall) fail("cowork_webhook_calls insert 후 반환된 행이 없음");
    webhookCallIds.push(insertedCall.id as number);
    console.log(`  cowork_webhook_calls에 테스트 행 삽입 완료(id=${insertedCall.id})`);

    const { count: rawCountAfter, error: countAfterError } = await supabaseAdmin
      .from("cowork_webhook_calls")
      .select("id", { count: "exact", head: true })
      .gt("called_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
    if (countAfterError) fail(`레이트리밋 카운트 쿼리(삽입 후) 실패: ${countAfterError.message}`);

    const before = rawCountBefore ?? 0;
    const after = rawCountAfter ?? 0;
    if (after !== before + 1) {
      fail(`레이트리밋 카운트가 insert 후 1 증가하지 않음: 삽입 전=${before}, 삽입 후=${after}`);
    }
    console.log(`  OK: 최근 24시간 카운트가 insert 후 정확히 1 증가함(${before} -> ${after})`);

    console.log("\n모든 검증 통과.");
  } finally {
    await cleanup(webhookCallIds);
  }
}

main().catch((error) => {
  console.error("\n검증 실패:", error instanceof Error ? error.message : error);
  process.exit(1);
});
