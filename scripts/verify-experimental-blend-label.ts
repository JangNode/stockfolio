/**
 * [디스포저블 검증 스크립트] 20260927230000 마이그레이션이 paper_strategies의
 * 실험조합형 활성 행 label/rationale을 실제로 새 값(57:38:5)으로 갱신했는지
 * 확인한다. 순수 조회, 쓰기 없음. 확인 후 삭제 예정.
 *
 * 필요 환경변수: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   tsx --conditions=react-server scripts/verify-experimental-blend-label.ts
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";

async function main(): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from("paper_strategies")
    .select("style, version, label, rationale, is_active")
    .eq("style", "experimental_blend")
    .eq("is_active", true)
    .maybeSingle();

  if (error) throw new Error(`조회 실패: ${error.message}`);
  if (!data) {
    console.log("활성 실험조합형 행을 찾지 못함");
    return;
  }

  console.log(`label: ${data.label}`);
  console.log(`rationale: ${data.rationale}`);
}

main().catch((error) => {
  console.error("검증 중 오류:", error);
  process.exit(1);
});
