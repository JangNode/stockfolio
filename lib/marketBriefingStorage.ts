import "server-only";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

/**
 * rawJson이 object이고 meta.date_kst가 비어있지 않은 문자열인지 확인해 그 값을
 * 돌려준다. 웹훅 라우트와 관리자 라우트 양쪽에서 호출하므로, 호출부에서 이미
 * 한 번 검증했더라도 여기서 다시 한번 방어적으로 확인한다.
 */
function extractDateKst(rawJson: unknown): string {
  if (typeof rawJson !== "object" || rawJson === null) {
    throw new Error("브리핑 데이터가 올바른 JSON 객체가 아닙니다.");
  }

  const meta = (rawJson as Record<string, unknown>).meta;
  if (typeof meta !== "object" || meta === null) {
    throw new Error("meta.date_kst가 없습니다.");
  }

  const dateKst = (meta as Record<string, unknown>).date_kst;
  if (typeof dateKst !== "string" || dateKst.trim() === "") {
    throw new Error("meta.date_kst가 없습니다.");
  }

  return dateKst;
}

/** 하루 1건만 유지하면 되므로 date_kst 기준으로 upsert한다(같은 날 재전송 시
 * 덮어쓰기). */
export async function upsertMarketBriefing(rawJson: unknown): Promise<{ dateKst: string }> {
  const dateKst = extractDateKst(rawJson);

  const { error } = await supabaseAdmin
    .from("market_briefings")
    .upsert({ date_kst: dateKst, raw_json: rawJson }, { onConflict: "date_kst" });

  if (error) throw new Error(`시장 브리핑 저장 실패: ${error.message}`);

  return { dateKst };
}
