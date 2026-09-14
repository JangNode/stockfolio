import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/requireAdmin";
import { upsertMarketBriefing } from "@/lib/marketBriefingStorage";

/** 관리자가 Cowork 브리핑 JSON을 수동으로 붙여넣어 백업 저장할 때 쓰는 경로. */
export async function POST(request: Request) {
  const denied = await requireAdmin(request);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "올바른 JSON이 아닙니다." }, { status: 400 });
  }

  try {
    const { dateKst } = await upsertMarketBriefing(body);
    return NextResponse.json({ ok: true, dateKst });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "저장에 실패했습니다." },
      { status: 400 }
    );
  }
}
