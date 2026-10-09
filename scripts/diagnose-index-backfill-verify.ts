/** [임시 — 병합 금지, 읽기 전용] 지수 백필 전/후 검증: 2016-01-04 이후 스냅샷, 2010~2015 값·거래일 대조. */
import { createHash } from "crypto";
import { getIndexPriceSeries } from "@/lib/betaPriceHistoryStorage";
import { loadAllStockSeriesFromParquet } from "@/lib/stockDailyPricesStorage";

async function main(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  for (const market of ["KOSPI", "KOSDAQ"] as const) {
    const all = await getIndexPriceSeries(market, "1990-01-01", today);
    const post = all.filter((p) => p.tradeDate >= "2016-01-04" && p.tradeDate <= "2026-10-02");
    const md5 = createHash("md5").update(post.map((p) => `${p.tradeDate}:${p.closePrice}`).join("|")).digest("hex");
    console.log(`[${market}] 2016-01-04~2026-10-02 스냅샷: ${post.length}행, 합계 ${post.reduce((s, p) => s + p.closePrice, 0).toFixed(2)}, md5 ${md5}`);
    const pre = all.filter((p) => p.tradeDate < "2016-01-01");
    console.log(`[${market}] 2016 이전 저장 행: ${pre.length} (${pre[0]?.tradeDate ?? "-"} ~ ${pre[pre.length - 1]?.tradeDate ?? "-"})`);
  }
  if (process.env.VERIFY_PRE === "true") {
    const stock = await loadAllStockSeriesFromParquet(2010, 2015);
    const stockDates = new Set<string>();
    for (const rows of stock.values()) for (const r of rows) if (r.tradeDate <= "2015-12-31") stockDates.add(r.tradeDate);
    console.log(`종목 시세 거래일 합집합(2010~2015): ${stockDates.size}일, ${[...stockDates].sort()[0]} ~ ${[...stockDates].sort().pop()}`);
    const expect: Record<string, Record<string, number>> = {
      KOSPI: { "2010-01-04": 1696.14, "2015-12-30": 1961.31 },
      KOSDAQ: { "2010-01-04": 528.09, "2015-12-30": 682.35 },
    };
    for (const market of ["KOSPI", "KOSDAQ"] as const) {
      const s = await getIndexPriceSeries(market, "2010-01-01", "2015-12-31");
      const dates = s.map((p) => p.tradeDate);
      const dup = dates.length - new Set(dates).size;
      const missing = [...stockDates].filter((d) => !dates.includes(d)).sort();
      const extra = dates.filter((d) => !stockDates.has(d));
      console.log(`[${market}] 2010~2015 지수 ${s.length}행 | 중복 ${dup} | 종목 거래일 대비 누락 ${missing.length}${missing.length ? " " + JSON.stringify(missing.slice(0, 30)) : ""} | 종목 거래일에 없는 지수일 ${extra.length}${extra.length ? " " + JSON.stringify(extra.slice(0, 30)) : ""}`);
      for (const [d, v] of Object.entries(expect[market])) {
        const got = s.find((p) => p.tradeDate === d)?.closePrice;
        console.log(`  ${d}: 기대 ${v} / 실제 ${got ?? "없음"} → ${got === v ? "일치" : "불일치"}`);
      }
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
