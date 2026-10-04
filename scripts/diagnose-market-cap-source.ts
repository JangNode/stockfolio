/**
 * 디스포저블 진단(읽기 전용): 시총 컬럼(marketCapEok)과 종가×상장주식수의 차이, 분할·병합 보정이 시총 계산에
 * 미치는 영향 확인. 시총 유니버스 실험(UNIVERSE_MIN_MARKET_CAP_EOK)의 시총 소스 선택 근거.
 */
import { loadAllStockSeriesFromParquet } from "@/lib/stockDailyPricesStorage";
import { loadAppliedAdjustments } from "@/lib/stockPriceAdjustmentsStorage";
import { applyAdjustmentsInPlace } from "@/lib/priceAdjustment";

const THRESHOLDS_EOK = [5000, 10000];

function quantile(sorted: number[], q: number): number {
  return sorted.length === 0 ? NaN : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

async function main(): Promise<void> {
  const series = await loadAllStockSeriesFromParquet(2015, new Date().getUTCFullYear());
  const rawStats = new Map<string, { n: number; zero: number; diffs: number[]; passStored: number[]; passComputed: number[]; disagree: number[] }>();
  const year = (d: string): string => d.slice(0, 4);
  const bucket = (y: string) => {
    let b = rawStats.get(y);
    if (!b) rawStats.set(y, (b = { n: 0, zero: 0, diffs: [], passStored: [0, 0], passComputed: [0, 0], disagree: [0, 0] }));
    return b;
  };
  // 보정 전(원가) 기준 비교 + 임계값별 편입 판정 불일치.
  for (const rows of series.values()) {
    for (const r of rows) {
      const b = bucket(year(r.tradeDate));
      b.n++;
      if (!(r.marketCapEok > 0)) b.zero++;
      if (r.listedShares > 0 && r.closePrice > 0 && r.marketCapEok > 0) {
        const computedEok = (r.closePrice * r.listedShares) / 1e8;
        b.diffs.push(Math.abs(r.marketCapEok - computedEok) / computedEok);
        THRESHOLDS_EOK.forEach((t, k) => {
          const a = r.marketCapEok >= t;
          const c = computedEok >= t;
          if (a) b.passStored[k]++;
          if (c) b.passComputed[k]++;
          if (a !== c) b.disagree[k]++;
        });
      }
    }
  }
  console.log("[시총 컬럼(marketCapEok) vs 종가×상장주식수] 연도별: 행 수, 시총 0/결측, 상대차이 중앙값/p99/최대, 5천억·1조 편입 판정 불일치");
  for (const y of Array.from(rawStats.keys()).sort()) {
    const b = rawStats.get(y)!;
    const d = [...b.diffs].sort((x, z) => x - z);
    console.log(
      `  ${y}: ${b.n}행, 0/결측 ${b.zero}, 차이 중앙 ${(quantile(d, 0.5) * 100).toFixed(3)}% / p99 ${(quantile(d, 0.99) * 100).toFixed(2)}% / 최대 ${((d[d.length - 1] ?? NaN) * 100).toFixed(1)}%, ` +
        `불일치(5천억 ${b.disagree[0]}행, 1조 ${b.disagree[1]}행)`
    );
  }

  // 분할·병합 보정이 시총에 미치는 영향: 보정 후에도 (marketCapEok, 종가×상장주식수)가 그대로인지.
  const adj = await loadAppliedAdjustments();
  let checked = 0;
  let changedCapColumn = 0;
  let changedProduct = 0;
  for (const [code, rows] of series) {
    const list = adj.get(code);
    if (!list) continue;
    const before = rows.map((r) => ({ cap: r.marketCapEok, prod: r.closePrice * r.listedShares }));
    applyAdjustmentsInPlace(rows, list);
    rows.forEach((r, i) => {
      checked++;
      if (r.marketCapEok !== before[i].cap) changedCapColumn++;
      const prod = r.closePrice * r.listedShares;
      if (before[i].prod > 0 && Math.abs(prod / before[i].prod - 1) > 1e-9) changedProduct++;
    });
  }
  console.log(`\n[보정 영향] 조정 대상 종목의 ${checked}행 중 시총 컬럼이 바뀐 행 ${changedCapColumn}, 종가×상장주식수가 바뀐 행 ${changedProduct}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
