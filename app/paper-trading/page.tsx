"use client";

import AppHeader from "@/components/AppHeader";
import RequireApproved from "@/components/RequireApproved";
import PaperTrading from "@/components/PaperTrading";

export default function PaperTradingPage() {
  return (
    <div className="flex flex-1 flex-col bg-zinc-50 dark:bg-black">
      <AppHeader />

      <main className="flex flex-1 flex-col items-center gap-6 p-4 sm:p-6">
        <RequireApproved>
          <PaperTrading />
        </RequireApproved>
      </main>
    </div>
  );
}
