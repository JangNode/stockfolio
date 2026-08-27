import Link from "next/link";
import StockChart from "@/components/StockChart";
import StockInvestorTrend from "@/components/StockInvestorTrend";
import StockValuation from "@/components/StockValuation";
import StockFinancials from "@/components/StockFinancials";
import StockPerformance from "@/components/StockPerformance";
import RequireApproved from "@/components/RequireApproved";
import type { Market } from "@/lib/market";

export default async function StockPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: Promise<{ name?: string; market?: string }>;
}) {
  const { code } = await params;
  const { name, market: marketParam } = await searchParams;
  const market: Market = marketParam === "US" ? "US" : "KR";

  return (
    <div className="flex flex-1 flex-col bg-zinc-50 dark:bg-black">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-black/[.08] px-4 py-3 sm:px-6 sm:py-4 dark:border-white/[.145]">
        <Link
          href="/"
          className="whitespace-nowrap text-sm text-zinc-500 hover:underline dark:text-zinc-400"
        >
          ← 관심종목
        </Link>
        <h1 className="text-lg font-semibold text-black dark:text-zinc-50">
          {name ?? code}{" "}
          <span className="text-sm font-normal text-zinc-400 dark:text-zinc-500">
            {code}
          </span>
        </h1>
      </header>

      <main className="flex flex-1 justify-center p-4 sm:p-6">
        <div className="flex w-full max-w-4xl justify-center">
          <RequireApproved>
            <div className="flex w-full flex-col">
              <StockChart code={code} market={market} />
              {market === "KR" && (
                <>
                  <StockInvestorTrend code={code} />
                  <StockValuation code={code} />
                  <StockFinancials code={code} />
                  <StockPerformance code={code} />
                </>
              )}
            </div>
          </RequireApproved>
        </div>
      </main>
    </div>
  );
}
