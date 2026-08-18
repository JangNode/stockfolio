import Link from "next/link";

export default function RequireLogin() {
  return (
    <div className="w-full max-w-sm rounded-xl border border-black/[.08] bg-white p-8 dark:border-white/[.145] dark:bg-zinc-950">
      <h2 className="mb-2 text-xl font-semibold text-black dark:text-zinc-50">
        로그인이 필요합니다
      </h2>
      <p className="mb-6 text-sm text-zinc-600 dark:text-zinc-400">
        이 기능을 사용하려면 로그인해주세요.
      </p>
      <Link
        href="/"
        className="inline-block h-11 rounded-full bg-foreground px-5 py-2.5 text-sm font-medium text-background transition-colors hover:bg-[#383838] dark:hover:bg-[#ccc]"
      >
        홈에서 로그인하기
      </Link>
    </div>
  );
}
