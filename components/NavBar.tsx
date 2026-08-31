"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMarket } from "@/components/MarketContext";
import { MARKET_LABELS, type Market } from "@/lib/market";

// 백테스트(/backtest)는 "전략 관리"의, AI 모의투자(/paper-trading)는 "실험실"의 하위
// 화면이라 그 화면으로 이동해도 상위 탭이 계속 활성 상태로 보이도록 매칭 경로를 더 둔다.
// 그렇지 않으면 상위 탭의 굵은 글씨가 사라지면서(폭이 줄어들며) 옆 탭들이 밀리는 것처럼
// 보인다.
const LINKS = [
  { href: "/", label: "관심종목", activePaths: ["/"] },
  { href: "/strategies", label: "전략 관리", activePaths: ["/strategies", "/backtest"] },
  { href: "/screening", label: "스크리닝", activePaths: ["/screening"] },
  { href: "/paper-trading", label: "실험실", activePaths: ["/lab", "/paper-trading"] },
  { href: "/themes", label: "테마", activePaths: ["/themes"] },
  { href: "/market-indicators", label: "시장 지표", activePaths: ["/market-indicators"] },
] as const;

// 테마(KRX 섹터)는 국내 종목마스터 플래그 기반이라 미국 시장 개념이 없다 —
// market-indicators와 동일하게 이 화면에서는 국내/미국 토글을 숨긴다.
const MARKET_TOGGLE_HIDDEN_PATHS = ["/market-indicators", "/themes"];

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
              (link.activePaths as readonly string[]).includes(pathname)
                ? "font-medium text-black dark:text-zinc-50"
                : "text-zinc-500 transition-colors hover:text-black dark:text-zinc-400 dark:hover:text-zinc-50"
            }`}
          >
            {link.label}
          </Link>
        ))}
      </nav>

      {!MARKET_TOGGLE_HIDDEN_PATHS.includes(pathname) && (
        <div className="ml-auto flex gap-1 rounded-full border border-black/[.08] p-0.5 dark:border-white/[.145]">
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
      )}
    </div>
  );
}
