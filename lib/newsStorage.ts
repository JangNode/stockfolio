import "server-only";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export interface CentralBankNewsRow {
  source: "FED" | "BOK";
  feedKey: string;
  title: string;
  link: string;
  publishedAt: string;
}

/** link에 걸린 unique 제약으로 중복 기사를 걸러낸다(ignoreDuplicates — 이미
 * 있는 링크는 조용히 무시). */
export async function upsertCentralBankNews(rows: CentralBankNewsRow[]): Promise<void> {
  if (rows.length === 0) return;
  const { error } = await supabaseAdmin.from("central_bank_news").upsert(
    rows.map((r) => ({
      source: r.source,
      feed_key: r.feedKey,
      title: r.title,
      link: r.link,
      published_at: r.publishedAt,
    })),
    { onConflict: "link", ignoreDuplicates: true }
  );
  if (error) throw new Error(`중앙은행 뉴스 저장 실패: ${error.message}`);
}

const RETENTION_DAYS = 30;

/** DB 용량이 빠듯해 최근 30일치만 보관한다 — 수집 배치가 매번 실행 끝에 함께
 * 정리해 별도 배치가 필요 없다. */
export async function deleteOldCentralBankNews(): Promise<void> {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { error } = await supabaseAdmin.from("central_bank_news").delete().lt("published_at", cutoff);
  if (error) throw new Error(`중앙은행 뉴스 정리 실패: ${error.message}`);
}

export interface CentralBankNewsItem {
  source: "FED" | "BOK";
  title: string;
  link: string;
  publishedAt: string;
}

export async function getRecentCentralBankNews(limit = 50): Promise<CentralBankNewsItem[]> {
  const { data, error } = await supabaseAdmin
    .from("central_bank_news")
    .select("source, title, link, published_at")
    .order("published_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`중앙은행 뉴스 조회 실패: ${error.message}`);
  return (data ?? []).map((r) => ({
    source: r.source as "FED" | "BOK",
    title: r.title,
    link: r.link,
    publishedAt: r.published_at,
  }));
}
