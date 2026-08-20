"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMarket } from "@/components/MarketContext";
import { MARKET_LABELS, type Market } from "@/lib/market";

const LINKS = [
  { href: "/", label: "관심종목" },
  { href: "/strategies", label: "전략 관리" },
  { href: "/backtest", label: "백테스트" },
  { href: "/screening", label: "스크리닝" },
  { href: "/paper-trading", label: "AI 모의투자" },
] as const;

const MARKET_TABS: Market[] = ["KR", "US"];

export default function NavBar() {
  const pathname = usePathname();
  const { market, setMarket } = useMarket();

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
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

      <div className="flex gap-1 rounded-full border border-black/[.08] p-0.5 dark:border-white/[.145]">
        {MARKET_TABS.map((m) => (
          <button
            key={m}
            onClick={() => setMarket(m)}
            className={`h-7 rounded-full px-3 text-xs font-medium transition-colors ${
              market === m
                ? "bg-foreground text-background"
                : "text-zinc-600 hover:bg-black/[.04] dark:text-zinc-400 dark:hover:bg-white/[.08]"
            }`}
          >
            {MARKET_LABELS[m]}
          </button>
        ))}
      </div>
    </div>
  );
}
