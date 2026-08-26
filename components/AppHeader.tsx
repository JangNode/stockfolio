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
 *
 * 좁은 화면(기본, ~639px)에서는 이메일을 아예 숨겨(hidden) 자리 자체를 차지하지
 * 않게 해서, 타이틀과 버튼 두 개가 한 줄에 나란히(justify-between) 들어가게 한다.
 * sm(640px) 이상에서는 이메일을 다시 보여주되, 행 전체의 정중앙이 아니라 타이틀
 * 바로 옆에 붙여서 보여준다(정중앙 정렬은 타이틀-버튼 사이 여백이 비대칭이라
 * 오히려 버튼 쪽에 더 가깝게 보이는 문제가 있었다).
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
    <header className="flex flex-col gap-3 border-b border-black/[.08] px-4 py-3 sm:px-6 sm:py-4 dark:border-white/[.145]">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-baseline gap-x-3">
          <h1 className="whitespace-nowrap text-lg font-semibold text-black dark:text-zinc-50">
            Stockfolio
          </h1>
          {user && (
            <span className="hidden min-w-0 truncate text-sm text-zinc-500 sm:inline dark:text-zinc-400">
              {user.email}
            </span>
          )}
        </div>

        {user && (
          <div className="flex shrink-0 items-center gap-3">
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
      </div>

      <NavBar />
    </header>
  );
}
