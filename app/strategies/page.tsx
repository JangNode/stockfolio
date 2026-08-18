"use client";

import { useUser } from "@/lib/useUser";
import NavBar from "@/components/NavBar";
import RequireLogin from "@/components/RequireLogin";
import StrategyManager from "@/components/StrategyManager";

export default function StrategiesPage() {
  const { user, loading } = useUser();

  return (
    <div className="flex flex-1 flex-col bg-zinc-50 dark:bg-black">
      <header className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-black/[.08] px-4 py-3 sm:px-6 sm:py-4 dark:border-white/[.145]">
        <h1 className="whitespace-nowrap text-lg font-semibold text-black dark:text-zinc-50">전략 관리</h1>
        <NavBar />
      </header>

      <main className="flex flex-1 flex-col items-center gap-6 p-4 sm:p-6">
        {!loading && (user ? <StrategyManager user={user} /> : <RequireLogin />)}
      </main>
    </div>
  );
}
