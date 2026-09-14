import { NextResponse } from "next/server";
import { requireApproved } from "@/lib/requireApproved";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

/** 가장 최근에 저장된 시장 브리핑 1건을 내려준다. 기록이 없는 것은 정상
 * 상태이므로 에러가 아니라 null로 응답한다. */
export async function GET(request: Request) {
  const denied = await requireApproved(request);
  if (denied) return denied;

  const { data, error } = await supabaseAdmin
    .from("market_briefings")
    .select("date_kst, raw_json")
    .order("date_kst", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    return NextResponse.json(
      { error: "시장 브리핑을 불러오지 못했습니다." },
      { status: 502 }
    );
  }

  if (!data) {
    return NextResponse.json({ dateKst: null, rawJson: null });
  }

  return NextResponse.json({ dateKst: data.date_kst, rawJson: data.raw_json });
}
