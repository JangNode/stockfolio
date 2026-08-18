import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { requireAdmin } from "@/lib/requireAdmin";

/**
 * 승인 대기(pending)/거절(rejected) 상태인 계정을 완전히 삭제한다. profiles
 * 행뿐 아니라 auth.users 계정 자체를 지워야 같은 이메일로 재가입할 수 있으므로
 * service_role 키로 Supabase Admin API의 deleteUser를 사용한다. profiles의
 * user_id가 auth.users(id)를 on delete cascade로 참조하므로, auth 계정을
 * 지우면 profiles 행은 자동으로 함께 삭제된다.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ userId: string }> }
) {
  const denied = await requireAdmin(request);
  if (denied) return denied;

  const { userId } = await params;

  const { data: target, error: targetError } = await supabaseAdmin
    .from("profiles")
    .select("status")
    .eq("user_id", userId)
    .maybeSingle();

  if (targetError) {
    return NextResponse.json(
      { error: "사용자 정보를 확인하지 못했습니다." },
      { status: 502 }
    );
  }

  if (!target) {
    return NextResponse.json(
      { error: "존재하지 않는 사용자입니다." },
      { status: 404 }
    );
  }

  // 승인된 사용자를 실수로 지우는 것을 막는다. 관리자 화면에서도 버튼을
  // 숨기지만, API 자체도 같은 규칙을 강제해야 우회 호출로부터 안전하다.
  if (target.status === "approved") {
    return NextResponse.json(
      { error: "승인된 사용자는 삭제할 수 없습니다." },
      { status: 400 }
    );
  }

  const { error: deleteError } = await supabaseAdmin.auth.admin.deleteUser(userId);
  if (deleteError) {
    return NextResponse.json(
      { error: `계정 삭제 실패: ${deleteError.message}` },
      { status: 502 }
    );
  }

  return NextResponse.json({ ok: true });
}
