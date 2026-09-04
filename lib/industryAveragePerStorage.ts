import "server-only";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

/**
 * 업종 그룹별 PER 중앙값(industry_average_per) 접근. 매일 1회
 * (scripts/calc-industry-average-per.ts)만 KIS를 호출해 계산·저장하고,
 * valuation API 라우트는 이 표를 조회만 한다(추가 KIS 호출 없음).
 */

const TABLE = "industry_average_per";

export interface IndustryAveragePerRow {
  indutyGroup: string;
  medianPer: number | null;
  peerCount: number;
}

interface IndustryAveragePerDbRow {
  induty_group: string;
  median_per: number | string | null;
  peer_count: number;
}

export async function getIndustryAveragePer(indutyGroup: string): Promise<IndustryAveragePerRow | null> {
  const { data, error } = await supabaseAdmin
    .from(TABLE)
    .select("induty_group, median_per, peer_count")
    .eq("induty_group", indutyGroup)
    .maybeSingle();
  if (error) throw new Error(`${indutyGroup} 업종 평균 PER 조회 실패: ${error.message}`);
  if (!data) return null;
  const row = data as IndustryAveragePerDbRow;
  return {
    indutyGroup: row.induty_group,
    medianPer: row.median_per === null ? null : Number(row.median_per),
    peerCount: row.peer_count,
  };
}

export async function upsertIndustryAveragePer(rows: IndustryAveragePerRow[]): Promise<void> {
  if (rows.length === 0) return;
  const { error } = await supabaseAdmin.from(TABLE).upsert(
    rows.map((r) => ({
      induty_group: r.indutyGroup,
      median_per: r.medianPer,
      peer_count: r.peerCount,
      computed_at: new Date().toISOString(),
    }))
  );
  if (error) throw new Error(`업종 평균 PER 저장 실패: ${error.message}`);
}
