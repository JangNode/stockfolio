"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "관심종목" },
  { href: "/strategies", label: "전략 관리" },
  { href: "/backtest", label: "백테스트" },
  { href: "/screening", label: "스크리닝" },
  { href: "/paper-trading", label: "AI 모의투자" },
] as const;

export default function NavBar() {
  const pathname = usePathname();

  return (
    <nav className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
      {LINKS.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          className={`whitespace-nowrap ${
            pathname === link.href
              ? "font-medium text-black dark:text-zinc-50"
              : "text-zinc-500 transition-colors hover:text-black dark:text-zinc-400 dark:hover:text-zinc-50"
          }`}
        >
          {link.label}
        </Link>
      ))}
    </nav>
  );
}
