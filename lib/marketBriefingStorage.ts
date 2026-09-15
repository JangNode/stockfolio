import "server-only";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

// RULES.md 3번(DB 용량 예산·보관 기간 정책)에 따른 보관 기간. 하루 1건·구조화된
// JSON 텍스트 수준이라 연간 증가량은 크지 않지만(추정 수 MB/년), 무기한 누적은
// 피하고 1년치만 유지한다.
const RETENTION_DAYS = 365;

/** report_date(YYYY-MM-DD) 형식 검증용. */
const DATE_KST_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * rawJson이 object이고 최상위 report_date가 YYYY-MM-DD 형식의 문자열인지
 * 확인해 그 값을 돌려준다. 웹훅 라우트와 관리자 라우트 양쪽에서 호출하므로,
 * 호출부에서 이미 한 번 검증했더라도 여기서 다시 한번 방어적으로 확인한다.
 */
function extractDateKst(rawJson: unknown): string {
  if (typeof rawJson !== "object" || rawJson === null) {
    throw new Error("브리핑 데이터가 올바른 JSON 객체가 아닙니다.");
  }

  const reportDate = (rawJson as Record<string, unknown>).report_date;
  if (typeof reportDate !== "string" || !DATE_KST_PATTERN.test(reportDate)) {
    throw new Error("report_date가 올바른 형식(YYYY-MM-DD)이 아닙니다.");
  }

  return reportDate;
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

/** date_kst 기준 보관 기간(RETENTION_DAYS)이 지난 브리핑을 정리한다. */
export async function deleteOldMarketBriefings(): Promise<void> {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const { error } = await supabaseAdmin.from("market_briefings").delete().lt("date_kst", cutoff);
  if (error) throw new Error(`시장 브리핑 정리 실패: ${error.message}`);
}
