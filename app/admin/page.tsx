"use client";

import { useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { supabase } from "@/lib/supabase";
import {
  PROFILE_COLUMNS,
  useSession,
  type Profile,
  type ProfileStatus,
} from "@/lib/useSession";

const SECTIONS: { status: ProfileStatus; title: string; empty: string }[] = [
  {
    status: "pending",
    title: "가입 신청",
    empty: "대기 중인 가입 신청이 없습니다.",
  },
  {
    status: "approved",
    title: "승인된 사용자",
    empty: "승인된 사용자가 없습니다.",
  },
  {
    status: "rejected",
    title: "거절된 사용자",
    empty: "거절된 사용자가 없습니다.",
  },
];

function formatDate(value: string | null): string {
  if (!value) return "-";
  return new Date(value).toLocaleString("ko-KR", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export default function AdminPage() {
  const { user, isAdmin, loading: sessionLoading } = useSession();
  const [actionError, setActionError] = useState("");
  const [pendingId, setPendingId] = useState<string | null>(null);

  const {
    data: profiles,
    error,
    isLoading,
    mutate,
  } = useSWR(isAdmin ? "admin-profiles" : null, async () => {
    const { data, error } = await supabase
      .from("profiles")
      .select(PROFILE_COLUMNS)
      .order("created_at", { ascending: false });

    if (error) throw error;
    return data as Profile[];
  });

  const updateStatus = async (userId: string, status: ProfileStatus) => {
    setActionError("");
    setPendingId(userId);

    const { error } = await supabase
      .from("profiles")
      .update({
        status,
        approved_at: status === "approved" ? new Date().toISOString() : null,
      })
      .eq("user_id", userId);

    setPendingId(null);

    if (error) {
      setActionError(error.message);
      return;
    }

    mutate();
  };

  return (
    <div className="flex flex-1 flex-col bg-zinc-50 dark:bg-black">
      <header className="flex items-center gap-4 border-b border-black/[.08] px-6 py-4 dark:border-white/[.145]">
        <Link
          href="/"
          className="text-sm text-zinc-500 hover:underline dark:text-zinc-400"
        >
          ← 관심종목
        </Link>
        <h1 className="text-lg font-semibold text-black dark:text-zinc-50">
          관리자
        </h1>
      </header>

      <main className="flex flex-1 justify-center p-6">
        {sessionLoading ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            불러오는 중...
          </p>
        ) : !user || !isAdmin ? (
          <div className="w-full max-w-md self-start rounded-xl border border-black/[.08] bg-white p-8 text-center dark:border-white/[.145] dark:bg-zinc-950">
            <h2 className="mb-3 text-xl font-semibold text-black dark:text-zinc-50">
              접근 권한이 없습니다
            </h2>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              관리자 계정으로만 이용할 수 있는 화면입니다.
            </p>
          </div>
        ) : (
          <div className="flex w-full max-w-3xl flex-col gap-6">
            {actionError && (
              <p className="text-sm text-blue-600 dark:text-blue-400">
                {actionError}
              </p>
            )}

            {isLoading ? (
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                사용자 목록을 불러오는 중...
              </p>
            ) : error ? (
              <p className="text-sm text-blue-600 dark:text-blue-400">
                사용자 목록을 불러오지 못했습니다.
              </p>
            ) : (
              SECTIONS.map(({ status, title, empty }) => {
                const rows = (profiles ?? []).filter(
                  (p) => p.status === status
                );

                return (
                  <section
                    key={status}
                    className="rounded-xl border border-black/[.08] bg-white p-4 dark:border-white/[.145] dark:bg-zinc-950"
                  >
                    <h2 className="mb-3 flex items-baseline gap-2 text-sm font-semibold text-black dark:text-zinc-50">
                      {title}
                      <span className="text-xs font-normal text-zinc-400 dark:text-zinc-500">
                        {rows.length}
                      </span>
                    </h2>

                    {rows.length === 0 ? (
                      <p className="text-sm text-zinc-500 dark:text-zinc-400">
                        {empty}
                      </p>
                    ) : (
                      <ul className="flex flex-col divide-y divide-black/[.08] dark:divide-white/[.145]">
                        {rows.map((profile) => (
                          <li
                            key={profile.user_id}
                            className="flex flex-wrap items-center justify-between gap-3 py-3"
                          >
                            <div className="min-w-0">
                              <p className="truncate text-sm text-black dark:text-zinc-50">
                                {profile.email || profile.user_id}
                                {profile.is_admin && (
                                  <span className="ml-2 rounded-full bg-black/[.06] px-1.5 py-0.5 text-[10px] font-medium text-zinc-500 dark:bg-white/[.08] dark:text-zinc-400">
                                    관리자
                                  </span>
                                )}
                              </p>
                              <p className="mt-0.5 text-xs text-zinc-400 dark:text-zinc-500">
                                가입 {formatDate(profile.created_at)}
                                {profile.status === "approved" &&
                                  ` · 승인 ${formatDate(profile.approved_at)}`}
                              </p>
                            </div>

                            <div className="flex shrink-0 gap-2">
                              {profile.status !== "approved" && (
                                <button
                                  onClick={() =>
                                    updateStatus(profile.user_id, "approved")
                                  }
                                  disabled={pendingId === profile.user_id}
                                  className="h-8 rounded-full bg-foreground px-4 text-sm font-medium text-background transition-colors hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc]"
                                >
                                  승인
                                </button>
                              )}
                              {profile.status !== "rejected" && (
                                <button
                                  onClick={() =>
                                    updateStatus(profile.user_id, "rejected")
                                  }
                                  disabled={
                                    pendingId === profile.user_id ||
                                    profile.user_id === user.id
                                  }
                                  title={
                                    profile.user_id === user.id
                                      ? "본인 계정은 거절할 수 없습니다."
                                      : undefined
                                  }
                                  className="h-8 rounded-full border border-black/[.08] px-4 text-sm font-medium text-black transition-colors hover:bg-black/[.04] disabled:opacity-50 dark:border-white/[.145] dark:text-zinc-50 dark:hover:bg-[#1a1a1a]"
                                >
                                  거절
                                </button>
                              )}
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                );
              })
            )}
          </div>
        )}
      </main>
    </div>
  );
}
