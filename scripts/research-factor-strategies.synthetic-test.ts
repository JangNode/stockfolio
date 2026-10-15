/** [임시] 합성 데이터로 research-factor-strategies.ts 실행 경로 점검. Supabase 접속 없음. */
import type { StockDailyPriceRow } from "@/lib/stockDailyPricesStorage";
import { runStudy, type FundLoad } from "./research-factor-strategies";

function rng(seed: number): () => number { let a = seed; return () => { a = (a * 1664525 + 1013904223) % 4294967296; return a / 4294967296; }; }
const series = new Map<string, StockDailyPriceRow[]>();
const dates: string[] = [];
for (let d = new Date("2010-01-04T00:00:00Z"); d <= new Date("2019-06-28T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 1)) {
  if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) dates.push(d.toISOString().slice(0, 10));
}
for (let s = 0; s < 150; s++) {
  const r = rng(s + 1);
  let p = 10000 + s * 100, drift = 0.0004;
  const rows: StockDailyPriceRow[] = [];
  dates.forEach((date, i) => {
    if (i % 250 === 0) drift = (r() - 0.45) * 0.003;
    p = Math.max(100, p * (1 + drift + (r() - 0.5) * 0.04));
    rows.push({ stockCode: String(100000 + s), tradeDate: date, closePrice: p, openPrice: p * 0.995, highPrice: p * 1.01, lowPrice: p * 0.99, volume: 100000, tradingValue: 2e10, marketCapEok: 6000 + s * 100, listedShares: 1e7 });
  });
  series.set(String(100000 + s), rows);
}
const kospi = dates.map((d, i) => ({ tradeDate: d, closePrice: 1500 + i }));
const loadFund = async (code: string): Promise<FundLoad> => {
  const s = Number(code) - 100000;
  const annual = [];
  const ls = new Map<number, number | null>();
  for (let fy = 2004; fy <= 2018; fy++) {
    const ni = (3e11 + s * 1e9) * Math.pow(1.1 + (s % 5) * 0.03, fy - 2004) * (fy === 2012 && s % 7 === 0 ? -1 : 1);
    annual.push({ fiscalYear: fy, rceptNo: `${fy + 1}0320000${s}`, rceptDate: `${fy + 1}-03-20`, netIncomeParent: ni, equityParent: 3e12 + s * 1e10, fsDiv: "CFS" as const });
    ls.set(fy, 1e7);
  }
  const dividends = s % 2 === 0 ? [2016, 2017, 2018].map((y) => ({ recordDate: `${y}-12-31`, cashDividendPerShare: 300, payDate: `${y + 1}-04-10` })) : [];
  return { series: { annual, dividends }, ls };
};
runStudy({ series, adjustments: new Map(), kospi, loadFund }).then(() => console.log("합성 테스트 종료")).catch((e) => { console.error(e); process.exit(1); });
