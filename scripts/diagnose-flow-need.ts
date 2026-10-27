/**
 * [임시 연구 — 병합 금지] 투자자 수급 보유 범위 점검(읽기 전용, 가격 성과·게이트 계산 없음, DB·Storage 쓰기 0, 외부 요청 0).
 * Storage의 수급 정리본(research/investor_flow_stock_clean, 약 17.8 MiB)과 N 연구 보완 파일(research/n_book/kis_flow_fill.parquet)을 읽어,
 * 고정 가격 스냅샷의 달력·종목과 대조해 (1) 연도별 K200P(PIT 코스피 시총 상위 200, 유동성 기준 포함) 구성 종목-일 중 수급 행이 있는 비율 (2) 코스피 보통주 전체 종목-일 대비 수급 보유 비율
 * (3) 없는 종목-일을 채우는 데 필요한 KIS 호출 수(종목별로 연속 구간을 병합해 구간 길이 ÷ 30행을 올림) (4) 정리본 마지막 날짜 뒤 갱신에 필요한 호출 수를 센다. 호출은 하지 않는다.
 */
import { decodeTable } from "@/lib/nBookStore";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { INVESTOR_FLOW_STOCK_STORE_BUCKET, INVESTOR_FLOW_STOCK_CLEAN_PREFIX, INVESTOR_FLOW_STOCK_PAGE_ROWS } from "@/lib/investorFlowConfig";
import { loadHarness, loadK200P, verifySnapshotManifest, storageLine, xfer, SNAP_END, f2 } from "./researchHarness";

const GAP_MERGE = 20; // 빈 날 사이 이 거래일 수 이하면 한 구간(N 연구 (d) 규칙과 같다)

async function main(): Promise<void> {
  console.log(`수급 보유 범위 점검 시작(읽기 전용): ${new Date().toISOString()}`);
  if (!SNAP_END || process.env.PARQUET_CACHE_FROZEN !== "1") throw new Error("고정 스냅샷 모드가 아니면 실행하지 않는다");
  console.log(await verifySnapshotManifest());
  const h = await loadHarness();
  const { kAt, membAt, excluded } = await loadK200P(h);
  const { CAL, nCal } = h;

  // ---- 수급 정리본 + 보완 파일 읽기 ----
  const have = new Map<string, Set<string>>();
  let rows = 0, lastDate = "";
  const dl = async (path: string): Promise<Record<string, unknown>[]> => {
    const r = await supabaseAdmin.storage.from(INVESTOR_FLOW_STOCK_STORE_BUCKET).download(path);
    if (r.error || !r.data) throw new Error(`${path} 없음`);
    xfer.bytes += (r.data as Blob).size;
    return (await decodeTable(await r.data.arrayBuffer())) as unknown as Record<string, unknown>[];
  };
  const { data: ls, error } = await supabaseAdmin.storage.from(INVESTOR_FLOW_STOCK_STORE_BUCKET).list(INVESTOR_FLOW_STOCK_CLEAN_PREFIX, { limit: 100 });
  if (error) throw new Error(error.message);
  for (const f of (ls ?? []).filter((x) => x.name.endsWith(".parquet")).map((x) => x.name).sort()) {
    for (const r of await dl(`${INVESTOR_FLOW_STOCK_CLEAN_PREFIX}/${f}`)) {
      const c = String(r.stock_code), d = String(r.trade_date);
      let s = have.get(c); if (!s) { s = new Set(); have.set(c, s); }
      s.add(d); rows++; if (d > lastDate) lastDate = d;
    }
  }
  console.log(`정리본: ${rows}행, 종목 ${have.size}개, 마지막 날짜 ${lastDate}`);
  const fill = await dl("research/n_book/kis_flow_fill.parquet");
  let fillNew = 0, fMin = "9999", fMax = "";
  const fillStocks = new Set<string>();
  for (const r of fill) { const c = String(r.stock_code), d = String(r.trade_date); fillStocks.add(c); if (d < fMin) fMin = d; if (d > fMax) fMax = d; let s = have.get(c); if (!s) { s = new Set(); have.set(c, s); } if (!s.has(d)) { s.add(d); fillNew++; } }
  console.log(`N 연구 보완 파일 kis_flow_fill: ${fill.length}행, 종목 ${fillStocks.size}개, ${fMin}~${fMax}, 정리본에 없던 새 종목-일 ${fillNew}행 → 합계 종목 ${have.size}개`);

  // ---- 대조 ----
  const years = [...new Set(CAL.slice(0, nCal).filter((d) => d >= "2010-01-01").map((d) => d.slice(0, 4)))];
  const kMiss = new Map<string, number[]>(); // 종목 → 빠진 달력 인덱스(K200P 소속일)
  const kospiMiss = new Map<string, number[]>();
  const per = new Map<string, { kd: number; kh: number; pd: number; ph: number }>();
  for (let c = 0; c < nCal; c++) {
    const d = CAL[c];
    if (d < "2010-01-01") continue;
    const v = per.get(d.slice(0, 4)) ?? { kd: 0, kh: 0, pd: 0, ph: 0 };
    for (const s of kAt(d)) { v.kd++; if (have.get(s.code)?.has(d)) v.kh++; else { const l = kMiss.get(s.code) ?? []; l.push(c); kMiss.set(s.code, l); } }
    const m = membAt(d);
    if (m) for (const s of h.stocks) {
      const i = s.idx.get(d);
      if (i === undefined || excluded.has(s.code) || m.get(s.code) !== "KOSPI") continue;
      v.pd++; if (have.get(s.code)?.has(d)) v.ph++; else { const l = kospiMiss.get(s.code) ?? []; l.push(c); kospiMiss.set(s.code, l); }
    }
    per.set(d.slice(0, 4), v);
  }
  console.log(`\n=== 연도별 수급 보유율 (정리본 + N 보완; 달력 = 가격 스냅샷 거래일) ===\n| 연도 | K200P 소속 종목-일 | 수급 있음 | % | 코스피 보통주 종목-일 | 수급 있음 | % |\n|---|---|---|---|---|---|---|`);
  let tk = 0, th = 0, tp = 0, tph = 0;
  for (const y of years) { const v = per.get(y)!; tk += v.kd; th += v.kh; tp += v.pd; tph += v.ph; console.log(`| ${y} | ${v.kd} | ${v.kh} | ${f2((v.kh / Math.max(v.kd, 1)) * 100)} | ${v.pd} | ${v.ph} | ${f2((v.ph / Math.max(v.pd, 1)) * 100)} |`); }
  console.log(`| 합계 | ${tk} | ${th} | ${f2((th / Math.max(tk, 1)) * 100)} | ${tp} | ${tph} | ${f2((tph / Math.max(tp, 1)) * 100)} |`);

  // ---- 채우기에 필요한 호출 수 ----
  const calls = (m: Map<string, number[]>): { stocks: number; ranges: number; calls: number; days: number } => {
    let ranges = 0, cl = 0, days = 0;
    for (const l of m.values()) {
      l.sort((a, b) => a - b);
      let start = l[0], prev = l[0];
      const close = (a: number, b: number): void => { ranges++; cl += Math.ceil((b - a + 1) / INVESTOR_FLOW_STOCK_PAGE_ROWS); };
      for (let k = 1; k < l.length; k++) { if (l[k] - prev > GAP_MERGE) { close(start, prev); start = l[k]; } prev = l[k]; }
      close(start, prev); days += l.length;
    }
    return { stocks: m.size, ranges, calls: cl, days };
  };
  const a = calls(kMiss), b = calls(kospiMiss);
  console.log(`\n=== 없는 종목-일을 채우는 데 필요한 KIS 호출(추정; 종목별 연속 구간 병합 간격 ${GAP_MERGE}거래일, 호출 1회 = 최대 ${INVESTOR_FLOW_STOCK_PAGE_ROWS}행) ===`);
  console.log(`K200P 소속일 기준: 빠진 종목 ${a.stocks}개, 빠진 종목-일 ${a.days}, 구간 ${a.ranges}개, 호출 약 ${a.calls}건`);
  console.log(`코스피 보통주 전체 기준: 빠진 종목 ${b.stocks}개, 빠진 종목-일 ${b.days}, 구간 ${b.ranges}개, 호출 약 ${b.calls}건`);
  const lastDay = CAL[nCal - 1];
  const after = CAL.slice(0, nCal).filter((d) => d > lastDate).length;
  console.log(`정리본 마지막 날짜 ${lastDate} 뒤 스냅샷 달력 끝(${lastDay})까지 거래일 ${after}일: 갱신은 종목당 1~2회(30행) × 종목 ${have.size}개 = 약 ${have.size}~${have.size * 2}건`);
  console.log(`\n${storageLine()} | Supabase 쓴 행 0 | Storage 쓰기 0 | 외부 요청 0 | 가격 성과 계산 없음 | 시도 번호 소진 없음`);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });
