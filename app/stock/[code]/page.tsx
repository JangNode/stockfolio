import Link from "next/link";
import StockChart from "@/components/StockChart";

export default async function StockPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: Promise<{ name?: string }>;
}) {
  const { code } = await params;
  const { name } = await searchParams;

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
          {name ?? code}{" "}
          <span className="text-sm font-normal text-zinc-400 dark:text-zinc-500">
            {code}
          </span>
        </h1>
      </header>

      <main className="flex flex-1 justify-center p-6">
        <div className="w-full max-w-4xl">
          <StockChart code={code} />
        </div>
      </main>
    </div>
  );
}
