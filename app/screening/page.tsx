"use client";

import { useSession } from "@/lib/useSession";
import NavBar from "@/components/NavBar";
import RequireApproved from "@/components/RequireApproved";
import Screening from "@/components/Screening";

export default function ScreeningPage() {
  const { user } = useSession();

  return (
    <div className="flex flex-1 flex-col bg-zinc-50 dark:bg-black">
      <header className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-black/[.08] px-4 py-3 sm:px-6 sm:py-4 dark:border-white/[.145]">
        <h1 className="whitespace-nowrap text-lg font-semibold text-black dark:text-zinc-50">스크리닝</h1>
        <NavBar />
      </header>

      <main className="flex flex-1 flex-col items-center gap-6 p-4 sm:p-6">
        <RequireApproved>
          {user && <Screening user={user} />}
        </RequireApproved>
      </main>
    </div>
  );
}
