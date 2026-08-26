"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

interface SubTab {
  href: string;
  label: string;
}

// 관련된 두 화면(예: 전략 관리↔백테스트, 실험실↔AI 모의투자)을 오가는 탭을
// 양쪽 페이지에서 이 컴포넌트로 공유해서 쓴다. 각 페이지가 스스로를 span으로,
// 상대를 Link로 하드코딩하면 순서가 뒤바뀌거나(클릭한 탭이 반대편으로 이동)
// 같은 목적지를 다른 라벨로 부르는(예: "커스텀 백테스트" vs "실험실") 불일치가
// 생기기 쉬우므로, 라벨과 순서를 하나의 배열로 고정하고 활성 여부만 pathname으로
// 판단한다.
export default function SubTabs({ tabs }: { tabs: SubTab[] }) {
  const pathname = usePathname();

  return (
    <div className="mb-4 flex items-center gap-4 text-sm">
      {tabs.map((tab) => (
        <Link
          key={tab.href}
          href={tab.href}
          className={`whitespace-nowrap ${
            pathname === tab.href
              ? "font-medium text-black dark:text-zinc-50"
              : "text-zinc-500 transition-colors hover:text-black dark:text-zinc-400 dark:hover:text-zinc-50"
          }`}
        >
          {tab.label}
        </Link>
      ))}
    </div>
  );
}

export const STRATEGY_BACKTEST_TABS: SubTab[] = [
  { href: "/strategies", label: "전략 목록" },
  { href: "/backtest", label: "백테스트" },
];

export const LAB_PAPER_TRADING_TABS: SubTab[] = [
  { href: "/paper-trading", label: "AI 모의투자" },
  { href: "/lab", label: "커스텀 백테스트" },
];
