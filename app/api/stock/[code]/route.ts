import { NextResponse } from "next/server";
import { getStockPrice } from "@/lib/kis";
import { requireApproved } from "@/lib/requireApproved";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ code: string }> }
) {
  const denied = await requireApproved(request);
  if (denied) return denied;

  const { code } = await params;

  try {
    const price = await getStockPrice(code);
    return NextResponse.json(price);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "알 수 없는 오류" },
      { status: 502 }
    );
  }
}
