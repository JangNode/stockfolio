"use client";

import { useUser } from "@/lib/useUser";
import NavBar from "@/components/NavBar";
import RequireLogin from "@/components/RequireLogin";
import Screening from "@/components/Screening";

export default function ScreeningPage() {
  const { user, loading } = useUser();

  return (
    <div className="flex flex-1 flex-col bg-zinc-50 dark:bg-black">
      <header className="flex items-center justify-between border-b border-black/[.08] px-6 py-4 dark:border-white/[.145]">
        <div className="flex items-center gap-6">
          <h1 className="text-lg font-semibold text-black dark:text-zinc-50">스크리닝</h1>
          <NavBar />
        </div>
      </header>

      <main className="flex flex-1 flex-col items-center gap-6 p-6">
        {!loading && (user ? <Screening user={user} /> : <RequireLogin />)}
      </main>
    </div>
  );
}
