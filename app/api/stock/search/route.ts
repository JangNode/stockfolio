import { NextRequest, NextResponse } from "next/server";
import { searchStocks } from "@/lib/stockMaster";
import { searchOverseasStocks } from "@/lib/stockMasterOverseas";
import { requireApproved } from "@/lib/requireApproved";

export async function GET(request: NextRequest) {
  const denied = await requireApproved(request);
  if (denied) return denied;

  const query = request.nextUrl.searchParams.get("q")?.trim() ?? "";
  const market = request.nextUrl.searchParams.get("market") === "US" ? "US" : "KR";

  if (!query) {
    return NextResponse.json([]);
  }

  try {
    if (market === "US") {
      const matches = await searchOverseasStocks(query, 8);
      return NextResponse.json(
        matches.map((m) => ({ code: m.code, name: m.name, exchange: m.exchange }))
      );
    }

    const matches = await searchStocks(query, 8);
    return NextResponse.json(matches);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "검색에 실패했습니다." },
      { status: 502 }
    );
  }
}
