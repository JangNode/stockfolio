/** [임시] 합성 데이터로 research-v3-portfolio-cap.ts의 실행 경로(오류 여부)를 점검한다. Supabase 접속 없음. */
import type { StockDailyPriceRow } from "@/lib/stockDailyPricesStorage";
import { runStudy } from "./research-audit-v3";

function rng(seed: number): () => number { let a = seed; return () => { a = (a * 1664525 + 1013904223) % 4294967296; return a / 4294967296; }; }

const series = new Map<string, StockDailyPriceRow[]>();
const dates: string[] = [];
for (let d = new Date("2009-01-05T00:00:00Z"); d <= new Date("2014-12-31T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 1)) {
  if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) dates.push(d.toISOString().slice(0, 10));
}
for (let s = 0; s < 60; s++) {
  const r = rng(s + 1);
  let p = 10000 + s * 100;
  const rows: StockDailyPriceRow[] = [];
  let drift = 0.0004;
  dates.forEach((date, i) => {
    if (i % 250 === 0) drift = (r() - 0.45) * 0.002;
    p = Math.max(100, p * (1 + drift + (r() - 0.5) * 0.04));
    rows.push({ stockCode: String(100000 + s), tradeDate: date, closePrice: p, openPrice: p * 0.995, highPrice: p * 1.01, lowPrice: p * 0.99, volume: 100000, tradingValue: 2e10, marketCapEok: 8000, listedShares: 1e7 });
  });
  series.set(String(100000 + s), rows);
}
let kp = 1500;
const kospi = dates.map((d, i) => { kp *= 1 + (rng(i + 7)() - 0.48) * 0.02; return { tradeDate: d, closePrice: kp }; });

runStudy({ series, kospi, reproGate: false }).then((r) => { console.log("합성 테스트 종료", r); }).catch((e) => { console.error(e); process.exit(1); });
