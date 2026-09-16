/**
 * "증시근황" 원본 JSON에 날짜/시각 관련 필드가 실제로 뭐가 있는지 확인하는
 * 디스포저블 스크립트(읽기 전용). 앱 전체 날짜/시각 표기 정리 작업의 조사
 * 단계에서, meta.publish_time_kst/coverage_note 같은 필드가 실제로 존재하는지
 * 확인하기 위함. 확인 후 삭제 예정.
 *   npx tsx --conditions=react-server scripts/diagnose-market-briefing-schema.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";

function collectDateTimeLikeKeys(obj: unknown, prefix: string, out: Record<string, unknown>): void {
  if (obj === null || typeof obj !== "object") return;
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (/date|time|session|zone|kst|utc|et\b/i.test(key)) {
      out[path] = value;
    }
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      collectDateTimeLikeKeys(value, path, out);
    }
  }
}

async function main(): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from("market_briefings")
    .select("date_kst, raw_json")
    .order("date_kst", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`market_briefings 조회 실패: ${error.message}`);
  if (!data) {
    console.log("market_briefings에 행이 없습니다.");
    return;
  }

  console.log(`가장 최근 date_kst=${data.date_kst}의 raw_json 최상위 키:`);
  console.log(Object.keys(data.raw_json as object).join(", "));

  const dateTimeLike: Record<string, unknown> = {};
  collectDateTimeLikeKeys(data.raw_json, "", dateTimeLike);
  console.log("\n날짜/시각 관련으로 보이는 필드(키에 date/time/session/zone/kst/utc/et 포함):");
  for (const [path, value] of Object.entries(dateTimeLike)) {
    console.log(`  ${path} = ${JSON.stringify(value)}`);
  }
}

main().catch((error) => {
  console.error("진단 스크립트 실행 중 오류:", error);
  process.exit(1);
});
