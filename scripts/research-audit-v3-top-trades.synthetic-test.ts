/** [임시] 합성 데이터로 research-audit-v3-top-trades.ts 실행 경로 점검. Supabase 접속 없음. */
import type { StockDailyPriceRow } from "@/lib/stockDailyPricesStorage";
import { runStudy } from "./research-audit-v3-top-trades";

function rng(seed: number): () => number { let a = seed; return () => { a = (a * 1664525 + 1013904223) % 4294967296; return a / 4294967296; }; }
const series = new Map<string, StockDailyPriceRow[]>();
const dates: string[] = [];
for (let d = new Date("2010-01-04T00:00:00Z"); d <= new Date("2014-12-31T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 1)) {
  if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) dates.push(d.toISOString().slice(0, 10));
}
for (let s = 0; s < 60; s++) {
  const r = rng(s + 1);
  let p = 10000 + s * 100, drift = 0.0004;
  const rows: StockDailyPriceRow[] = [];
  dates.forEach((date, i) => {
    if (i % 250 === 0) drift = (r() - 0.4) * 0.003;
    p = Math.max(100, p * (1 + drift + (r() - 0.5) * 0.04));
    rows.push({ stockCode: String(100000 + s), tradeDate: date, closePrice: p, openPrice: p * 0.995, highPrice: p * 1.01, lowPrice: p * 0.99, volume: 100000, tradingValue: 2e10, marketCapEok: 8000, listedShares: 1e7 + (i === 500 ? 5 : 0) });
  });
  series.set(String(100000 + s), s < 50 ? rows : rows.slice(0, 700));
}
const events = [{ stock_code: "100003", event_date: dates[400], adjustment_factor: 2, status: "low_confidence" }];
runStudy({ series, events, reproGate: false }).then((r) => console.log("합성 테스트 종료", r)).catch((e) => { console.error(e); process.exit(1); });
