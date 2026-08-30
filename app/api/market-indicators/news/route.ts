import { NextResponse } from "next/server";
import { requireApproved } from "@/lib/requireApproved";
import { getRecentCentralBankNews } from "@/lib/newsStorage";

/** FOMC/한국은행 관련 뉴스 최근 목록을 내려준다. 제목/출처/시각/링크만 —
 * 해석(매파/비둘기파 등)은 붙이지 않는다. */
export async function GET(request: Request) {
  const denied = await requireApproved(request);
  if (denied) return denied;

  try {
    const news = await getRecentCentralBankNews(50);
    return NextResponse.json({ news });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "알 수 없는 오류" },
      { status: 502 }
    );
  }
}
