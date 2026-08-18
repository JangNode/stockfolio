"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import ApprovalNotice from "@/components/ApprovalNotice";
import { useSession } from "@/lib/useSession";

/**
 * 승인된 사용자에게만 children을 보여준다. 로그인 여부와 승인 상태를 클라이언트에서
 * 확인하므로, 실제 데이터 접근 차단은 watchlist RLS와 API 라우트 가드가 담당한다.
 */
export default function RequireApproved({ children }: { children: ReactNode }) {
  const { user, status, isApproved, profileError, loading } = useSession();

  if (loading) {
    return (
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        불러오는 중...
      </p>
    );
  }

  if (!user) {
    return (
      <div className="w-full max-w-md rounded-xl border border-black/[.08] bg-white p-8 text-center dark:border-white/[.145] dark:bg-zinc-950">
        <h2 className="mb-3 text-xl font-semibold text-black dark:text-zinc-50">
          로그인이 필요합니다
        </h2>
        <Link
          href="/"
          className="text-sm text-zinc-600 hover:underline dark:text-zinc-400"
        >
          로그인 화면으로 이동
        </Link>
      </div>
    );
  }

  if (profileError) {
    return (
      <div className="w-full max-w-md rounded-xl border border-black/[.08] bg-white p-8 text-center dark:border-white/[.145] dark:bg-zinc-950">
        <h2 className="mb-3 text-xl font-semibold text-black dark:text-zinc-50">
          승인 상태를 확인하지 못했습니다
        </h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          {profileError.message}
        </p>
      </div>
    );
  }

  if (!isApproved) {
    return <ApprovalNotice status={status} email={user.email} />;
  }

  return <>{children}</>;
}
