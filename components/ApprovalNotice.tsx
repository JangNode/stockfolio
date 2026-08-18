"use client";

import type { ProfileStatus } from "@/lib/useSession";

const COPY: Record<
  Exclude<ProfileStatus, "approved">,
  { title: string; body: string }
> = {
  pending: {
    title: "관리자 승인 대기 중입니다",
    body: "가입 신청이 접수되었습니다. 관리자가 승인하면 관심종목을 비롯한 모든 기능을 이용할 수 있습니다.",
  },
  rejected: {
    title: "가입이 거절되었습니다",
    body: "관리자가 이 계정의 가입 신청을 거절했습니다. 문의가 필요하면 관리자에게 연락해주세요.",
  },
};

export default function ApprovalNotice({
  status,
  email,
}: {
  status: ProfileStatus;
  email?: string | null;
}) {
  if (status === "approved") return null;

  const { title, body } = COPY[status];

  return (
    <div className="w-full max-w-md rounded-xl border border-black/[.08] bg-white p-8 text-center dark:border-white/[.145] dark:bg-zinc-950">
      <h2 className="mb-3 text-xl font-semibold text-black dark:text-zinc-50">
        {title}
      </h2>
      <p className="text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
        {body}
      </p>
      {email && (
        <p className="mt-4 text-xs text-zinc-400 dark:text-zinc-500">{email}</p>
      )}
    </div>
  );
}
