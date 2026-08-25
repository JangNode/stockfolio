"use client";

import Link from "next/link";
import { useSession } from "@/lib/useSession";
import AppHeader from "@/components/AppHeader";
import RequireApproved from "@/components/RequireApproved";
import ChangePassword from "@/components/ChangePassword";

export default function SettingsPage() {
  const { user, isAdmin } = useSession();

  return (
    <div className="flex flex-1 flex-col bg-zinc-50 dark:bg-black">
      <AppHeader />

      <main className="flex flex-1 flex-col items-center gap-6 p-4 sm:p-6">
        <RequireApproved>
          {user && <ChangePassword user={user} />}

          {isAdmin && (
            <div className="w-full max-w-sm rounded-xl border border-black/[.08] bg-white p-6 dark:border-white/[.145] dark:bg-zinc-950">
              <h2 className="mb-2 text-lg font-semibold text-black dark:text-zinc-50">관리자</h2>
              <p className="mb-4 text-sm text-zinc-600 dark:text-zinc-400">
                가입 승인 및 사용자 관리 화면으로 이동합니다.
              </p>
              <Link
                href="/admin"
                className="flex h-10 w-full items-center justify-center rounded-full border border-black/[.08] px-5 text-sm font-medium text-black transition-colors hover:bg-black/[.04] dark:border-white/[.145] dark:text-zinc-50 dark:hover:bg-[#1a1a1a]"
              >
                관리자 화면으로 이동
              </Link>
            </div>
          )}
        </RequireApproved>
      </main>
    </div>
  );
}
