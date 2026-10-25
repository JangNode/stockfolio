/**
 * [임시 측정 — 정리 대상, Storage·DB 쓰기 0] 일일 Parquet 갱신안의 Storage 다운로드·업로드 바이트 측정.
 * 현재 연도·직전 연도 파일에 대해: Storage 메타데이터 크기, 디스크 캐시 적중 여부(PARQUET_CACHE_DIR 있을 때), 실제 다운로드 바이트,
 * 하루치가 더해진 파일을 backfill 스크립트와 같은 방식으로 직렬화했을 때의 업로드 바이트(업로드는 하지 않음).
 */
import { parquetWriteBuffer } from "hyparquet-writer";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { downloadYearPrices } from "@/lib/stockDailyPricesStorage";
import { parquetCacheStats } from "@/lib/parquetDiskCache";

const MiB = 1048576;
const f2 = (x: number): string => x.toFixed(2);

async function run(): Promise<void> {
  const cacheOn = !!process.env.PARQUET_CACHE_DIR?.trim();
  const now = new Date();
  const years = [now.getUTCFullYear() - 1, now.getUTCFullYear()];
  console.log(`디스크 캐시 ${cacheOn ? "켜짐(PARQUET_CACHE_DIR)" : "꺼짐(매번 Storage에서 받음)"} | 대상 연도 ${years.join(", ")}`);
  console.log(`| 연도 | Storage 크기 MiB | 행 수 | 거래일 수 | 일평균 행 | 이번 실행 다운로드(캐시 적중이면 0) MiB | 하루 추가 후 직렬화(=업로드) MiB |\n|---|---|---|---|---|---|---|`);
  let dl = 0;
  const ups: number[] = [];
  for (const y of years) {
    const { data } = await supabaseAdmin.storage.from("stock-daily-prices").list("", { search: `${y}.parquet` });
    const meta = (data ?? []).find((e) => e.name === `${y}.parquet`);
    const size = Number((meta?.metadata as { size?: number } | null)?.size ?? NaN);
    const before = { ...parquetCacheStats };
    const rows = await downloadYearPrices(y);
    const downloaded = cacheOn ? parquetCacheStats.downloadBytes - before.downloadBytes : size;
    const days = new Set(rows.map((r) => r.tradeDate)).size;
    const perDay = rows.length / Math.max(days, 1);
    const sample = rows.slice(-Math.round(perDay)).map((r) => ({ ...r }));
    const merged = [...rows, ...sample];
    const buf = parquetWriteBuffer({ columnData: [
      { name: "stock_code", data: merged.map((r) => r.stockCode), type: "STRING" }, { name: "trade_date", data: merged.map((r) => r.tradeDate), type: "STRING" },
      { name: "close_price", data: merged.map((r) => r.closePrice), type: "DOUBLE" }, { name: "market_cap_eok", data: merged.map((r) => r.marketCapEok), type: "DOUBLE" },
      { name: "listed_shares", data: merged.map((r) => r.listedShares), type: "DOUBLE" }, { name: "open_price", data: merged.map((r) => r.openPrice), type: "DOUBLE" },
      { name: "volume", data: merged.map((r) => r.volume), type: "DOUBLE" }, { name: "high_price", data: merged.map((r) => r.highPrice), type: "DOUBLE" },
      { name: "low_price", data: merged.map((r) => r.lowPrice), type: "DOUBLE" }, { name: "trading_value", data: merged.map((r) => r.tradingValue), type: "DOUBLE" },
    ] });
    dl += downloaded; ups.push(buf.byteLength);
    console.log(`| ${y} | ${f2(size / MiB)} | ${rows.length} | ${days} | ${f2(perDay)} | ${f2(downloaded / MiB)} | ${f2(buf.byteLength / MiB)} |`);
  }
  console.log(`합계: 이번 실행 다운로드 ${f2(dl / MiB)} MiB | 업로드(하루 추가 후 재직렬화) 현재 연도만 ${f2(ups[1] / MiB)} MiB, 두 해 모두 ${f2((ups[0] + ups[1]) / MiB)} MiB`);
  console.log(`디스크 캐시 통계: 적중 ${parquetCacheStats.hits}건(${f2(parquetCacheStats.hitBytes / MiB)} MiB), 다운로드 ${parquetCacheStats.downloads}건(${f2(parquetCacheStats.downloadBytes / MiB)} MiB)`);
}
run().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });
