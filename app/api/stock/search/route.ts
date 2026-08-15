import { NextRequest, NextResponse } from "next/server";
import { searchStocks } from "@/lib/stockMaster";

export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams.get("q")?.trim() ?? "";

  if (!query) {
    return NextResponse.json([]);
  }

  try {
    const matches = await searchStocks(query, 8);
    return NextResponse.json(matches);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "검색에 실패했습니다." },
      { status: 502 }
    );
  }
}
