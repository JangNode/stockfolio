import "server-only";
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

/**
 * 시세 API 라우트의 공통 접근 제어. Authorization 헤더의 액세스 토큰으로
 * 사용자를 확인하고, profiles.status가 approved인 경우에만 통과시킨다.
 * 통과하면 null을, 막아야 하면 그대로 반환할 응답을 돌려준다.
 */
export async function requireApproved(
  request: Request
): Promise<NextResponse | null> {
  const token = request.headers
    .get("authorization")
    ?.replace(/^Bearer\s+/i, "")
    .trim();

  if (!token) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }

  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }

  const { data: profile, error: profileError } = await supabaseAdmin
    .from("profiles")
    .select("status")
    .eq("user_id", data.user.id)
    .maybeSingle();

  if (profileError) {
    return NextResponse.json(
      { error: "승인 상태를 확인하지 못했습니다." },
      { status: 502 }
    );
  }

  if (profile?.status !== "approved") {
    return NextResponse.json(
      { error: "관리자 승인 대기 중입니다." },
      { status: 403 }
    );
  }

  return null;
}
