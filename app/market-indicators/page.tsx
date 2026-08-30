"use client";

import { useSession } from "@/lib/useSession";
import AppHeader from "@/components/AppHeader";
import RequireApproved from "@/components/RequireApproved";
import MarketIndicators from "@/components/MarketIndicators";

export default function MarketIndicatorsPage() {
  const { user } = useSession();

  return (
    <div className="flex flex-1 flex-col bg-zinc-50 dark:bg-black">
      <AppHeader />

      <main className="flex flex-1 flex-col items-center gap-6 p-4 sm:p-6">
        <RequireApproved>{user && <MarketIndicators />}</RequireApproved>
      </main>
    </div>
  );
}
