"use client";

import NavBar from "@/components/NavBar";
import RequireApproved from "@/components/RequireApproved";
import PaperTrading from "@/components/PaperTrading";

export default function PaperTradingPage() {
  return (
    <div className="flex flex-1 flex-col bg-zinc-50 dark:bg-black">
      <header className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-black/[.08] px-4 py-3 sm:px-6 sm:py-4 dark:border-white/[.145]">
        <h1 className="whitespace-nowrap text-lg font-semibold text-black dark:text-zinc-50">AI 모의투자</h1>
        <NavBar />
      </header>

      <main className="flex flex-1 flex-col items-center gap-6 p-4 sm:p-6">
        <RequireApproved>
          <PaperTrading />
        </RequireApproved>
      </main>
    </div>
  );
}
