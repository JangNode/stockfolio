"use client";

import { useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { useSession } from "@/lib/useSession";
import NavBar from "@/components/NavBar";

/**
 * 탭이 있는 화면(관심종목/전략 관리/백테스트/실험실/스크리닝/AI 모의투자)이 공통으로
 * 쓰는 상단 헤더. 타이틀은 항상 "Stockfolio"로 고정하고(페이지별 텍스트를 받지 않음),
 * 로그인한 사용자의 이메일/설정/로그아웃을 모든 탭에서 동일하게 보여준다(이전엔
 * app/page.tsx에만 있어서 다른 탭에서는 로그아웃하려면 관심종목으로 돌아가야 했다).
 */
export default function AppHeader() {
  const { user } = useSession();
  const [signingOut, setSigningOut] = useState(false);

  const handleSignOut = async () => {
    setSigningOut(true);
    await supabase.auth.signOut();
    setSigningOut(false);
  };

  return (
    <header className="flex flex-col gap-3 border-b border-black/[.08] px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6 sm:py-4 dark:border-white/[.145]">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="whitespace-nowrap text-lg font-semibold text-black dark:text-zinc-50">
            Stockfolio
          </h1>
          {user && (
            <span className="min-w-0 truncate text-sm text-zinc-500 dark:text-zinc-400">
              {user.email}
            </span>
          )}
        </div>
        <NavBar />
      </div>

      {user && (
        <div className="flex items-center justify-between gap-3 sm:justify-end">
          <Link
            href="/settings"
            className="flex h-9 shrink-0 items-center rounded-full border border-black/[.08] px-4 text-sm font-medium text-black transition-colors hover:bg-black/[.04] dark:border-white/[.145] dark:text-zinc-50 dark:hover:bg-[#1a1a1a]"
          >
            설정
          </Link>
          <button
            onClick={handleSignOut}
            disabled={signingOut}
            className="h-9 shrink-0 rounded-full border border-black/[.08] px-4 text-sm font-medium text-black transition-colors hover:bg-black/[.04] disabled:opacity-50 dark:border-white/[.145] dark:text-zinc-50 dark:hover:bg-[#1a1a1a]"
          >
            로그아웃
          </button>
        </div>
      )}
    </header>
  );
}
