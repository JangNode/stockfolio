"use client";

import { useState } from "react";
import Link from "next/link";
import { authFetch } from "@/lib/authFetch";
import { useSession } from "@/lib/useSession";

export default function AdminMarketBriefingsPage() {
  const { user, isAdmin, loading: sessionLoading } = useSession();
  const [text, setText] = useState("");
  const [validationError, setValidationError] = useState("");
  const [resultMessage, setResultMessage] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setValidationError("");
    setResultMessage("");

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      setValidationError("올바른 JSON이 아닙니다.");
      return;
    }

    if (typeof parsed !== "object" || parsed === null) {
      setValidationError("JSON 객체 형태여야 합니다.");
      return;
    }

    const reportDate = (parsed as Record<string, unknown>).report_date;

    if (typeof reportDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) {
      setValidationError("report_date가 올바른 형식(YYYY-MM-DD)이 아닙니다.");
      return;
    }

    setSaving(true);
    const res = await authFetch("/api/admin/market-briefings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: text,
    });
    const data = await res.json().catch(() => ({}));
    setSaving(false);

    if (!res.ok) {
      setResultMessage(data.error ?? "저장에 실패했습니다.");
      return;
    }

    setResultMessage(`저장되었습니다 (${data.dateKst}).`);
  };

  return (
    <div className="flex flex-1 flex-col bg-zinc-50 dark:bg-black">
      <header className="flex items-center gap-4 border-b border-black/[.08] px-6 py-4 dark:border-white/[.145]">
        <Link
          href="/admin"
          className="text-sm text-zinc-500 hover:underline dark:text-zinc-400"
        >
          ← 관리자
        </Link>
        <h1 className="text-lg font-semibold text-black dark:text-zinc-50">
          시장 브리핑 수동 백업
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
          <div className="flex w-full max-w-3xl flex-col gap-4">
            <div className="rounded-xl border border-black/[.08] bg-white p-4 dark:border-white/[.145] dark:bg-zinc-950">
              <p className="mb-3 text-sm text-zinc-500 dark:text-zinc-400">
                Cowork 브리핑 JSON을 붙여넣고 저장하면 웹훅으로 받은 것과
                동일하게 저장됩니다. 같은 날짜(report_date)가 이미 있으면
                덮어씁니다.
              </p>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={16}
                placeholder='{ "report_date": "2026-09-14", ... }'
                className="w-full rounded-lg border border-black/[.08] bg-transparent p-3 font-mono text-xs text-black outline-none focus:border-black/30 dark:border-white/[.145] dark:text-zinc-50 dark:focus:border-white/30"
              />

              {validationError && (
                <p className="mt-3 text-sm text-blue-600 dark:text-blue-400">
                  {validationError}
                </p>
              )}
              {resultMessage && (
                <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">
                  {resultMessage}
                </p>
              )}

              <button
                onClick={handleSave}
                disabled={saving || text.trim() === ""}
                className="mt-4 h-10 rounded-full bg-foreground px-4 text-sm font-medium text-background transition-colors hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc]"
              >
                {saving ? "저장 중..." : "저장"}
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
