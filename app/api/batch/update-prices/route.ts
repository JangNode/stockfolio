import { NextResponse } from "next/server";
import { getStockPrice } from "@/lib/kis";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export const maxDuration = 60;

// 종목 시세 조회 사이에 두는 여유 간격. lib/kis.ts가 이미 모든 KIS 호출을 전역
// 큐로 직렬화하지만, 관심종목 수가 많을 때 호출이 몰리지 않도록 한 겹 더
// 여유를 둔다.
const DELAY_BETWEEN_STOCKS_MS = 300;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;

  return request.headers.get("authorization") === `Bearer ${secret}`;
}

async function getWatchlistStockCodes(): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from("watchlist")
    .select("stock_code");

  if (error) {
    throw new Error(`관심종목 조회 실패: ${error.message}`);
  }

  return Array.from(new Set((data ?? []).map((row) => row.stock_code as string)));
}

interface UpdateResult {
  stockCode: string;
  ok: boolean;
  error?: string;
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json(
      { error: "인증되지 않은 요청입니다." },
      { status: 401 }
    );
  }

  let stockCodes: string[];
  try {
    stockCodes = await getWatchlistStockCodes();
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "알 수 없는 오류" },
      { status: 502 }
    );
  }

  const results: UpdateResult[] = [];

  for (const stockCode of stockCodes) {
    try {
      const price = await getStockPrice(stockCode);

      const { error } = await supabaseAdmin.from("stock_prices").insert({
        stock_code: price.stockCode,
        price: price.currentPrice,
        change: price.change,
        change_rate: price.changeRate,
        volume: price.volume,
      });

      if (error) {
        throw new Error(error.message);
      }

      results.push({ stockCode, ok: true });
    } catch (error) {
      results.push({
        stockCode,
        ok: false,
        error: error instanceof Error ? error.message : "알 수 없는 오류",
      });
    }

    await sleep(DELAY_BETWEEN_STOCKS_MS);
  }

  const succeeded = results.filter((r) => r.ok).length;

  return NextResponse.json({
    total: stockCodes.length,
    succeeded,
    failed: stockCodes.length - succeeded,
    results,
  });
}
