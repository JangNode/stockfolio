import "server-only";

const FED_MONETARY_RSS_URL = "https://www.federalreserve.gov/feeds/press_monetary.xml";

export interface FedRssItem {
  title: string;
  guid: string;
  pubDate: string;
}

/**
 * Fed 통화정책 보도자료 RSS(연준이 직접 발행, federalreserve.gov/feeds/feeds.htm에
 * 안내됨)를 가져와 <item> 목록으로 파싱한다. FRED는 연준 발표를 받아 정리하는 2차
 * 소스라 몇 분 지연될 수 있는데, 이 피드는 연준이 직접 발행하는 1차 소스라 더
 * 빠르다 — scripts/check-rate-announcement.ts가 미국 발표 감지 대기 중 이 피드를
 * 짧은 주기로 폴링해, 새 "Federal Reserve issues FOMC statement" 항목이 뜨면 남은
 * 대기를 건너뛰고 바로 FRED를 확인하는 가속 트리거로만 쓴다 — 실제 금리 수치는
 * 이 피드의 자유 텍스트를 파싱하지 않고 항상 FRED에서만 가져온다(자연어 파싱은
 * 깨지기 쉬워 신뢰할 수 있는 수치 소스로 쓰기엔 부적절하다).
 */
export async function getFedMonetaryPolicyReleases(): Promise<FedRssItem[]> {
  const res = await fetch(FED_MONETARY_RSS_URL, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; stockfolio-rss-fastpath/1.0)" },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Fed RSS 피드 요청 실패 (${res.status})`);
  }
  const xml = await res.text();

  const items: FedRssItem[] = [];
  const itemPattern = /<item>([\s\S]*?)<\/item>/g;
  for (const m of xml.matchAll(itemPattern)) {
    const block = m[1];
    const title = block.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim() ?? "";
    const guid = block.match(/<guid>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/guid>/)?.[1]?.trim() ?? "";
    const pubDate = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]?.trim() ?? "";
    if (guid) items.push({ title, guid, pubDate });
  }
  return items;
}
