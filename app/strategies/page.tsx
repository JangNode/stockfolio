"use client";

import { useSession } from "@/lib/useSession";
import AppHeader from "@/components/AppHeader";
import RequireApproved from "@/components/RequireApproved";
import StrategyManager from "@/components/StrategyManager";

export default function StrategiesPage() {
  const { user } = useSession();

  return (
    <div className="flex flex-1 flex-col bg-zinc-50 dark:bg-black">
      <AppHeader />

      <main className="flex flex-1 flex-col items-center gap-6 p-4 sm:p-6">
        <RequireApproved>
          {user && <StrategyManager user={user} />}
        </RequireApproved>
      </main>
    </div>
  );
}
