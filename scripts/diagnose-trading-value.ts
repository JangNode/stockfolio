/**
 * [임시 연구 — 병합 금지] 연구 D 정정(시도 242~244) 진단: Parquet 원본 trading_value 열이 0 또는 결측인 K200P 소속 종목-일의 연도별 행 수·비율과,
 * trading_value와 종가×거래량이 둘 다 있는 행의 비율(trading_value ÷ (원 종가 × 거래량)) 분포. 읽기 전용(고정 스냅샷 + 월말 시장 목록 0.21 MiB), 가격 성과 계산 없음, 외부 요청 0.
 */
import { loadHarness, loadK200P, verifySnapshotManifest, SNAP_END, f2, storageLine } from "./researchHarness";

const q = (a: number[], p: number): number => (a.length ? a[Math.min(Math.floor(a.length * p), a.length - 1)] : NaN);

async function main(): Promise<void> {
  console.log(`거래대금 열 진단 시작: ${new Date().toISOString()}`);
  if (!SNAP_END || process.env.PARQUET_CACHE_FROZEN !== "1") throw new Error("고정 스냅샷 모드가 아니면 실행하지 않는다");
  console.log(await verifySnapshotManifest());
  const h = await loadHarness();
  const { kAt } = await loadK200P(h);
  const cS = h.CAL.findIndex((d) => d >= "2011-01-01");
  const yr = new Map<string, { n: number; zero: number; volZero: number; ratios: number[] }>();
  for (let c = cS; c < h.nCal; c++) {
    const d = h.CAL[c], y = d.slice(0, 4);
    let e = yr.get(y);
    if (!e) { e = { n: 0, zero: 0, volZero: 0, ratios: [] }; yr.set(y, e); }
    for (const s of kAt(d)) {
      const i = s.idx.get(d);
      if (i === undefined) continue;
      e.n++;
      const alt = s.raw[i] * s.vol[i];
      if (!(s.tv[i] > 0)) e.zero++;
      if (!(alt > 0)) e.volZero++;
      if (s.tv[i] > 0 && alt > 0) e.ratios.push(s.tv[i] / alt);
    }
  }
  console.log(`\n=== K200P 소속 종목-일(월말 구성원, 평가 시작 ${h.CAL[cS]}~) 연도별 trading_value 열 ===\n| 연도 | 종목-일 | trading_value 0 또는 결측 | 비율 % | 종가×거래량 0 | 둘 다 있는 행 | 비율(tv ÷ 종가×거래량) 중앙값 | 5분위 | 95분위 |\n|---|---|---|---|---|---|---|---|---|`);
  let tn = 0, tz = 0;
  for (const [y, e] of [...yr].sort()) {
    const r = [...e.ratios].sort((a, b) => a - b);
    tn += e.n; tz += e.zero;
    console.log(`| ${y} | ${e.n} | ${e.zero} | ${f2((e.zero / Math.max(e.n, 1)) * 100)} | ${e.volZero} | ${r.length} | ${r.length ? f2(q(r, 0.5)) : "-"} | ${r.length ? f2(q(r, 0.05)) : "-"} | ${r.length ? f2(q(r, 0.95)) : "-"} |`);
  }
  console.log(`전체 ${tn}건 중 trading_value 0 또는 결측 ${tz}건(${f2((tz / Math.max(tn, 1)) * 100)}%)`);
  console.log(`${storageLine()} | Supabase 쓴 행 0 | Storage 쓰기 0 | 외부 요청 0 | 가격 성과 계산 없음 | 시도 번호 소진 없음`);
}
main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });
