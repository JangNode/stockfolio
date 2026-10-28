/**
 * [임시 연구 — 병합 금지] 하네스 확장(시가·고가·저가·거래대금) 검증: 수정주가의 시가·고가·저가가 종가와 같은 계수로 수정되는지 조정 이벤트 5건 전후로 확인한다.
 * 읽기 전용(고정 스냅샷 + DB 조정 이벤트 읽기), 가격 성과 계산 없음, 외부 요청 0, Storage 읽기 0.
 */
import { loadAllStockSeriesFromParquet } from "@/lib/stockDailyPricesStorage";
import { applyAdjustmentsInPlace } from "@/lib/priceAdjustment";
import { loadHarness, verifySnapshotManifest, SNAP_END } from "./researchHarness";

async function main(): Promise<void> {
  console.log(`하네스 OHLC 확장 검증 시작: ${new Date().toISOString()}`);
  if (!SNAP_END || process.env.PARQUET_CACHE_FROZEN !== "1") throw new Error("고정 스냅샷 모드가 아니면 실행하지 않는다");
  console.log(await verifySnapshotManifest());
  const h = await loadHarness();
  const series = await loadAllStockSeriesFromParquet(2010, Number(SNAP_END.slice(0, 4)));
  const evs: { code: string; date: string; factor: number }[] = [];
  for (const [code, list] of h.adjustments) for (const e of list) if (e.eventDate >= "2011-01-01" && e.eventDate <= "2026-06-30") evs.push({ code, date: e.eventDate, factor: e.factor });
  evs.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.code < b.code ? -1 : 1));
  const fs = evs.map((e) => e.factor).sort((a, b) => a - b);
  console.log(`적용된 조정 이벤트(2011~2026-06) ${evs.length}건, 종목 ${new Set(evs.map((e) => e.code)).size}개, 계수 최소 ${fs[0]} / 중앙값 ${fs[Math.floor(fs.length / 2)]} / 최대 ${fs[fs.length - 1]} (이 표는 분할·병합 등 가격 기준 이벤트만 담고 배당락 조정은 없다 — 수정주가는 가격 수익 기준)`);
  // 전 종목 일치 검증: 하네스 S의 수정 시가·고가·저가·종가가 같은 코드 경로(applyAdjustmentsInPlace)로 독립 계산한 값과 같은지, 그리고 시가·고가·저가·종가의 수정 계수 비율이 같은지
  let rowsChk = 0, maxRatioDiff = 0, maxHarnessDiff = 0, tvMismatch = 0;
  for (const [code, rows] of series) {
    const s = h.byCode.get(code), al = h.adjustments.get(code);
    if (!s || !al) continue;
    const adj = rows.map((r) => ({ ...r }));
    applyAdjustmentsInPlace(adj, al);
    for (let i = 0; i < rows.length; i++) {
      const j = s.idx.get(rows[i].tradeDate);
      if (j === undefined || rows[i].tradeDate > SNAP_END) continue;
      rowsChk++;
      const rc = rows[i].closePrice > 0 ? adj[i].closePrice / rows[i].closePrice : NaN;
      for (const [a, r] of [[adj[i].openPrice, rows[i].openPrice], [adj[i].highPrice, rows[i].highPrice], [adj[i].lowPrice, rows[i].lowPrice]] as const) if (r > 0 && Number.isFinite(rc)) maxRatioDiff = Math.max(maxRatioDiff, Math.abs(a / r / rc - 1));
      maxHarnessDiff = Math.max(maxHarnessDiff, Math.abs(s.open[j] - adj[i].openPrice), Math.abs(s.high[j] - adj[i].highPrice), Math.abs(s.low[j] - adj[i].lowPrice), Math.abs(s.close[j] - adj[i].closePrice));
      if (s.tv[j] !== rows[i].tradingValue) tvMismatch++;
    }
  }
  console.log(`조정 이벤트가 있는 종목의 행 ${rowsChk}개 검사: (수정 시가·고가·저가 ÷ 원값) ÷ (수정 종가 ÷ 원종가) − 1 의 최대 절댓값 ${maxRatioDiff.toExponential(2)} | 하네스 S의 시가·고가·저가·종가와 독립 계산 값의 최대 차이 ${maxHarnessDiff.toExponential(2)} | 거래대금 불일치 ${tvMismatch}행`);
  // 이벤트 5건 전후 표본(균등 간격)
  const pick: typeof evs = [];
  for (let k = 0; k < 5; k++) pick.push(evs[Math.floor(((k + 0.5) * evs.length) / 5)]);
  console.log(`\n=== 이벤트 5건 전후 (원값 → 수정값; 시가/고가/저가/종가, 계수 ${"{"}이벤트일 이전 행에 곱함${"}"}) ===`);
  for (const e of pick) {
    const rows = series.get(e.code)!, al = h.adjustments.get(e.code)!;
    const adj = rows.map((r) => ({ ...r }));
    applyAdjustmentsInPlace(adj, al);
    const i0 = rows.findIndex((r) => r.tradeDate >= e.date);
    console.log(`\n종목 ${e.code} 이벤트일 ${e.date} 계수 ${e.factor} (이 종목 이벤트 ${al.length}건)`);
    console.log(`| 날짜 | 원 시/고/저/종 | 수정 시/고/저/종 | 수정/원 (시, 고, 저, 종) |\n|---|---|---|---|`);
    for (let i = Math.max(i0 - 2, 0); i <= Math.min(i0 + 2, rows.length - 1); i++) {
      const r = rows[i], a = adj[i];
      const q = (x: number, y: number): string => (y > 0 ? (x / y).toFixed(4) : "-");
      console.log(`| ${r.tradeDate} | ${r.openPrice}/${r.highPrice}/${r.lowPrice}/${r.closePrice} | ${a.openPrice.toFixed(1)}/${a.highPrice.toFixed(1)}/${a.lowPrice.toFixed(1)}/${a.closePrice.toFixed(1)} | ${q(a.openPrice, r.openPrice)}, ${q(a.highPrice, r.highPrice)}, ${q(a.lowPrice, r.lowPrice)}, ${q(a.closePrice, r.closePrice)} |`);
    }
    if (i0 >= 1) console.log(`이벤트일 갭: 원값 시가 ÷ 전일 종가 − 1 = ${((rows[i0].openPrice / rows[i0 - 1].closePrice - 1) * 100).toFixed(2)}% → 수정값 ${((adj[i0].openPrice / adj[i0 - 1].closePrice - 1) * 100).toFixed(2)}%`);
  }
  console.log(`\nSupabase 쓴 행 0 | Storage 쓰기·읽기 0 | 외부 요청 0 | 가격 성과 계산 없음 | 시도 번호 소진 없음`);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });
