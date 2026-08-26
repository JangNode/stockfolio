/**
 * DART(전자공시) 전체 법인 목록(corpCode.xml)을 다시 받아 dart_corp_codes 표를 갱신하는
 * 배치 스크립트. DART가 이 매핑을 가끔(비정기) 갱신하므로 매주 1회 실행한다
 * (.github/workflows/sync-dart-corp-codes.yml).
 *
 * server-only로 막힌 lib/dart.ts, lib/supabaseAdmin.ts를 순수 Node 스크립트에서도
 * 그대로 재사용하기 위해 "react-server" 조건으로 실행해야 한다:
 *   tsx --conditions=react-server scripts/sync-dart-corp-codes.ts
 * (package.json의 sync:dart-corp-codes 스크립트가 이 플래그를 포함한다.)
 *
 * 필요 환경변수: DART_API_KEY, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchCorpCodeMap } from "@/lib/dart";

// 전체 법인이 10만 건 이상이라(비상장 포함) 한 번에 upsert하지 않고 나눠서 보낸다.
const UPSERT_BATCH_SIZE = 1000;

async function main(): Promise<void> {
  console.log("DART corp_code 매핑 동기화 시작");

  const entries = await fetchCorpCodeMap();
  console.log(`DART로부터 ${entries.length}건 수신`);

  let upserted = 0;
  for (let i = 0; i < entries.length; i += UPSERT_BATCH_SIZE) {
    const batch = entries.slice(i, i + UPSERT_BATCH_SIZE).map((e) => ({
      corp_code: e.corpCode,
      corp_name: e.corpName,
      stock_code: e.stockCode,
      modify_date: e.modifyDate,
      updated_at: new Date().toISOString(),
    }));

    const { error } = await supabaseAdmin.from("dart_corp_codes").upsert(batch, { onConflict: "corp_code" });
    if (error) {
      throw new Error(`dart_corp_codes upsert 실패(배치 ${i}~${i + batch.length}): ${error.message}`);
    }

    upserted += batch.length;
    console.log(`  진행: ${upserted}/${entries.length}`);
  }

  const listedCount = entries.filter((e) => e.stockCode !== null).length;
  console.log(`DART corp_code 매핑 동기화 완료: 전체 ${upserted}건 (상장사 ${listedCount}건)`);
}

main().catch((error) => {
  console.error("DART corp_code 매핑 동기화 중 오류가 발생했습니다:", error);
  process.exit(1);
});
