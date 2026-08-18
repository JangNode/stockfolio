import "server-only";
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

/**
 * 관리자 전용 API 라우트의 공통 접근 제어. Authorization 헤더의 액세스 토큰으로
 * 사용자를 확인하고, profiles.status가 approved이면서 is_admin인 경우에만
 * 통과시킨다. 통과하면 null을, 막아야 하면 그대로 반환할 응답을 돌려준다.
 */
export async function requireAdmin(request: Request): Promise<NextResponse | null> {
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
    .select("status, is_admin")
    .eq("user_id", data.user.id)
    .maybeSingle();

  if (profileError) {
    return NextResponse.json(
      { error: "권한을 확인하지 못했습니다." },
      { status: 502 }
    );
  }

  if (profile?.status !== "approved" || !profile.is_admin) {
    return NextResponse.json(
      { error: "관리자만 이용할 수 있습니다." },
      { status: 403 }
    );
  }

  return null;
}
