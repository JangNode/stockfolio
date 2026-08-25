"use client";

import { useState } from "react";
import type { User } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";

const MIN_PASSWORD_LENGTH = 8;

const inputClassName =
  "h-11 rounded-lg border border-black/[.08] bg-transparent px-4 text-sm text-black outline-none focus:border-black/30 dark:border-white/[.145] dark:text-zinc-50 dark:focus:border-white/30";

export default function ChangePassword({ user }: { user: User }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [isError, setIsError] = useState(false);

  const handleSubmit = async () => {
    setMessage("");
    setIsError(false);

    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setIsError(true);
      setMessage(`새 비밀번호는 ${MIN_PASSWORD_LENGTH}자 이상이어야 합니다.`);
      return;
    }
    if (newPassword !== confirmPassword) {
      setIsError(true);
      setMessage("새 비밀번호가 일치하지 않습니다.");
      return;
    }
    if (!user.email) {
      setIsError(true);
      setMessage("계정 이메일을 확인할 수 없습니다.");
      return;
    }

    setLoading(true);
    try {
      // 세션 탈취만으로 비밀번호를 바꿀 수 없도록, 현재 비밀번호로 재인증에
      // 성공했을 때만 새 비밀번호로 교체한다.
      const { error: reauthError } = await supabase.auth.signInWithPassword({
        email: user.email,
        password: currentPassword,
      });
      if (reauthError) {
        setIsError(true);
        setMessage("현재 비밀번호가 올바르지 않습니다.");
        return;
      }

      const { error: updateError } = await supabase.auth.updateUser({ password: newPassword });
      if (updateError) {
        setIsError(true);
        setMessage(updateError.message);
        return;
      }

      setMessage("비밀번호가 변경되었습니다.");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch {
      setIsError(true);
      setMessage("비밀번호 변경 중 오류가 발생했습니다.");
    } finally {
      setLoading(false);
    }
  };

  const canSubmit = !loading && currentPassword && newPassword && confirmPassword;

  return (
    <div className="w-full max-w-sm rounded-xl border border-black/[.08] bg-white p-8 dark:border-white/[.145] dark:bg-zinc-950">
      <h2 className="mb-2 text-xl font-semibold text-black dark:text-zinc-50">비밀번호 변경</h2>
      <p className="mb-6 text-sm text-zinc-600 dark:text-zinc-400">
        현재 비밀번호를 확인한 뒤에만 새 비밀번호로 변경됩니다.
      </p>

      <div className="flex flex-col gap-4">
        <input
          type="password"
          placeholder="현재 비밀번호"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          autoComplete="current-password"
          className={inputClassName}
        />
        <input
          type="password"
          placeholder="새 비밀번호 (8자 이상)"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          autoComplete="new-password"
          className={inputClassName}
        />
        <input
          type="password"
          placeholder="새 비밀번호 확인"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          autoComplete="new-password"
          className={inputClassName}
        />

        <button
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="h-11 rounded-full bg-foreground px-5 text-sm font-medium text-background transition-colors hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc]"
        >
          {loading ? "변경 중..." : "비밀번호 변경"}
        </button>
      </div>

      {message && (
        <p
          className={`mt-4 text-sm ${
            isError ? "text-blue-600 dark:text-blue-400" : "text-zinc-600 dark:text-zinc-400"
          }`}
        >
          {message}
        </p>
      )}
    </div>
  );
}
