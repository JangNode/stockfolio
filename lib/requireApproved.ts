import "server-only";
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export interface ApprovedUser {
  id: string;
}

type ApprovedCheckResult = { response: NextResponse } | { user: ApprovedUser };

/**
 * Authorization 헤더의 액세스 토큰으로 사용자를 확인하고, profiles.status가
 * approved인 경우에만 통과시킨다. requireApproved/requireApprovedUser가 공유하는
 * 내부 구현.
 */
async function checkApproved(request: Request): Promise<ApprovedCheckResult> {
  const token = request.headers
    .get("authorization")
    ?.replace(/^Bearer\s+/i, "")
    .trim();

  if (!token) {
    return { response: NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 }) };
  }

  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) {
    return { response: NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 }) };
  }

  const { data: profile, error: profileError } = await supabaseAdmin
    .from("profiles")
    .select("status")
    .eq("user_id", data.user.id)
    .maybeSingle();

  if (profileError) {
    return {
      response: NextResponse.json({ error: "승인 상태를 확인하지 못했습니다." }, { status: 502 }),
    };
  }

  if (profile?.status !== "approved") {
    return {
      response: NextResponse.json({ error: "관리자 승인 대기 중입니다." }, { status: 403 }),
    };
  }

  return { user: { id: data.user.id } };
}

/**
 * 시세 API 라우트 등 사용자 식별이 필요 없는 라우트의 공통 접근 제어.
 * 통과하면 null을, 막아야 하면 그대로 반환할 응답을 돌려준다.
 */
export async function requireApproved(request: Request): Promise<NextResponse | null> {
  const result = await checkApproved(request);
  return "response" in result ? result.response : null;
}

/**
 * 요청자의 user_id가 필요한 라우트(예: 실험실 백테스트 요청)의 공통 접근 제어.
 * 통과하면 사용자 정보를, 막아야 하면 그대로 반환할 응답을 돌려준다.
 */
export async function requireApprovedUser(request: Request): Promise<ApprovedCheckResult> {
  return checkApproved(request);
}
