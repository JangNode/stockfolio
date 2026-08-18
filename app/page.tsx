"use client";

import { useState } from "react";
<<<<<<< HEAD
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { useSession } from "@/lib/useSession";
import Watchlist from "@/components/Watchlist";
import MarketSummary from "@/components/MarketSummary";
import ApprovalNotice from "@/components/ApprovalNotice";
=======
import { supabase } from "@/lib/supabase";
import { useUser } from "@/lib/useUser";
import Watchlist from "@/components/Watchlist";
import MarketSummary from "@/components/MarketSummary";
import NavBar from "@/components/NavBar";
>>>>>>> origin/main

export default function Home() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
<<<<<<< HEAD
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  const { user, status, isApproved, isAdmin, loading: sessionLoading } =
    useSession();

=======
  const { user } = useUser();
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

>>>>>>> origin/main
  const handleSignUp = async () => {
    setLoading(true);
    setMessage("");
    const { error } = await supabase.auth.signUp({ email, password });
    setMessage(
      error
        ? error.message
        : "가입 신청이 접수되었습니다. 확인 이메일을 확인한 뒤, 관리자 승인이 완료되면 이용할 수 있습니다."
    );
    setLoading(false);
  };

  const handleSignIn = async () => {
    setLoading(true);
    setMessage("");
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    setMessage(error ? error.message : "로그인되었습니다.");
    setLoading(false);
  };

  const handleSignOut = async () => {
    setLoading(true);
    setMessage("");
    const { error } = await supabase.auth.signOut();
    setMessage(error ? error.message : "");
    setLoading(false);
  };

  return (
    <div className="flex flex-1 flex-col bg-zinc-50 dark:bg-black">
      <header className="flex flex-col gap-3 border-b border-black/[.08] px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6 sm:py-4 dark:border-white/[.145]">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 sm:justify-start">
          <h1 className="whitespace-nowrap text-lg font-semibold text-black dark:text-zinc-50">
            Stockfolio
          </h1>
          <NavBar />
        </div>
        {user && (
<<<<<<< HEAD
          <div className="flex items-center gap-3">
            {isAdmin && (
              <Link
                href="/admin"
                className="flex h-9 items-center rounded-full border border-black/[.08] px-4 text-sm font-medium text-black transition-colors hover:bg-black/[.04] dark:border-white/[.145] dark:text-zinc-50 dark:hover:bg-[#1a1a1a]"
              >
                관리자
              </Link>
            )}
            <span className="text-sm text-zinc-600 dark:text-zinc-400">
=======
          <div className="flex items-center justify-between gap-3 sm:justify-end">
            <span className="min-w-0 truncate text-sm text-zinc-600 dark:text-zinc-400">
>>>>>>> origin/main
              {user.email}
            </span>
            <button
              onClick={handleSignOut}
              disabled={loading}
              className="h-9 shrink-0 rounded-full border border-black/[.08] px-4 text-sm font-medium text-black transition-colors hover:bg-black/[.04] disabled:opacity-50 dark:border-white/[.145] dark:text-zinc-50 dark:hover:bg-[#1a1a1a]"
            >
              로그아웃
            </button>
          </div>
        )}
      </header>

<<<<<<< HEAD
      <main className="flex flex-1 flex-col items-center gap-6 p-6">
        {sessionLoading ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            불러오는 중...
          </p>
        ) : !user ? (
=======
      <main className="flex flex-1 flex-col items-center gap-6 p-4 sm:p-6">
        <MarketSummary />

        {user ? (
          <Watchlist user={user} />
        ) : (
>>>>>>> origin/main
          <div className="w-full max-w-sm rounded-xl border border-black/[.08] bg-white p-8 dark:border-white/[.145] dark:bg-zinc-950">
            <h2 className="mb-2 text-xl font-semibold text-black dark:text-zinc-50">
              로그인이 필요합니다
            </h2>
            <p className="mb-6 text-sm text-zinc-600 dark:text-zinc-400">
              관심종목을 보려면 로그인하거나 계정을 만들어주세요. 새로 가입한
              계정은 관리자 승인 후 이용할 수 있습니다.
            </p>

            <div className="flex flex-col gap-4">
              <input
                type="email"
                placeholder="이메일"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="h-11 rounded-lg border border-black/[.08] bg-transparent px-4 text-sm text-black outline-none focus:border-black/30 dark:border-white/[.145] dark:text-zinc-50 dark:focus:border-white/30"
              />
              <input
                type="password"
                placeholder="비밀번호"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="h-11 rounded-lg border border-black/[.08] bg-transparent px-4 text-sm text-black outline-none focus:border-black/30 dark:border-white/[.145] dark:text-zinc-50 dark:focus:border-white/30"
              />
              <div className="flex gap-3">
                <button
                  onClick={handleSignIn}
                  disabled={loading || !email || !password}
                  className="h-11 flex-1 rounded-full bg-foreground px-5 text-sm font-medium text-background transition-colors hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc]"
                >
                  로그인
                </button>
                <button
                  onClick={handleSignUp}
                  disabled={loading || !email || !password}
                  className="h-11 flex-1 rounded-full border border-black/[.08] px-5 text-sm font-medium text-black transition-colors hover:bg-black/[.04] disabled:opacity-50 dark:border-white/[.145] dark:text-zinc-50 dark:hover:bg-[#1a1a1a]"
                >
                  회원가입
                </button>
              </div>
            </div>

            {message && (
              <p className="mt-4 text-sm text-zinc-600 dark:text-zinc-400">
                {message}
              </p>
            )}
          </div>
        ) : !isApproved ? (
          <ApprovalNotice status={status} email={user.email} />
        ) : (
          <>
            <MarketSummary />
            <Watchlist user={user} />
          </>
        )}
      </main>
    </div>
  );
}
