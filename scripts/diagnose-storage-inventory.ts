/**
 * [임시 연구 — 병합 금지] Supabase 연구 객체 현황(읽기 전용, DB·Storage 쓰기 0, 외부 요청 0).
 * INV_MODE=list: Storage 객체 메타데이터만(경로·크기·수정 시각; 내려받기 0). 버킷별 합계, research/ 아래 접두사별 합계, PEAD 관련 이름 검색.
 * INV_MODE=db: 투자자 수급 DB 표(investor_flow_market, investor_flow_stock_pilot) 행 수·기간·종목 수·결측.
 * INV_MODE=read: 수급 Parquet(research/investor_flow_stock, _clean) 내려받아 연도별 행 수·종목 수·기간·결측률(내려받은 MiB 보고).
 */
import { parquetReadObjects } from "hyparquet";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { INVESTOR_FLOW_STOCK_STORE_BUCKET, INVESTOR_FLOW_STOCK_STORE_PREFIX, INVESTOR_FLOW_STOCK_CLEAN_PREFIX } from "@/lib/investorFlowConfig";

const MODE = process.env.INV_MODE ?? "list";
const MiB = 1048576;
const f2 = (x: number): string => (Number.isFinite(x) ? x.toFixed(2) : "-");
interface Obj { bucket: string; path: string; size: number; updated: string }

async function listAll(): Promise<Obj[]> {
  const out: Obj[] = [];
  const { data: buckets, error } = await supabaseAdmin.storage.listBuckets();
  if (error) throw new Error(`버킷 목록 실패: ${error.message}`);
  for (const b of buckets ?? []) {
    const walk = async (prefix: string): Promise<void> => {
      for (let offset = 0; ; offset += 1000) {
        const { data, error: e2 } = await supabaseAdmin.storage.from(b.name).list(prefix, { limit: 1000, offset });
        if (e2) throw new Error(`목록 실패 ${b.name}/${prefix}: ${e2.message}`);
        for (const it of data ?? []) {
          const p = prefix ? `${prefix}/${it.name}` : it.name;
          if (it.id === null) await walk(p);
          else out.push({ bucket: b.name, path: p, size: Number((it.metadata as { size?: number } | null)?.size ?? 0), updated: String((it as { updated_at?: string }).updated_at ?? "") });
        }
        if ((data?.length ?? 0) < 1000) break;
      }
    };
    await walk("");
  }
  return out;
}

async function main(): Promise<void> {
  console.log(`Supabase 연구 객체 현황 INV_MODE=${MODE}: ${new Date().toISOString()}`);
  if (MODE === "list") {
    const all = await listAll();
    const per = new Map<string, { n: number; b: number }>();
    for (const o of all) { const v = per.get(o.bucket) ?? { n: 0, b: 0 }; v.n++; v.b += o.size; per.set(o.bucket, v); }
    console.log(`\n=== 버킷별 객체 수·크기 ===\n${[...per].map(([k, v]) => `${k}: ${v.n}개 ${(v.b / MiB).toFixed(2)} MiB`).join("\n")}\n합계 ${all.length}개 ${(all.reduce((a, o) => a + o.size, 0) / MiB).toFixed(2)} MiB`);
    const res = all.filter((o) => o.bucket === INVESTOR_FLOW_STOCK_STORE_BUCKET && o.path.startsWith("research/"));
    const grp = new Map<string, { n: number; b: number }>();
    for (const o of res) { const g = o.path.split("/").slice(0, 2).join("/"); const v = grp.get(g) ?? { n: 0, b: 0 }; v.n++; v.b += o.size; grp.set(g, v); }
    console.log(`\n=== ${INVESTOR_FLOW_STOCK_STORE_BUCKET}/research/ 아래 접두사별 ===\n${[...grp].sort().map(([k, v]) => `${k}: ${v.n}개 ${(v.b / MiB).toFixed(2)} MiB`).join("\n")}\n연구 접두사 합계 ${res.length}개 ${(res.reduce((a, o) => a + o.size, 0) / MiB).toFixed(2)} MiB`);
    console.log(`\n=== 파일 목록(연구 접두사 중 파일 수가 적은 접두사는 전부, 많은 접두사는 앞 30개) ===`);
    for (const [g] of [...grp].sort()) {
      const files = res.filter((o) => o.path.startsWith(`${g}/`) || o.path === g);
      const shown = files.length <= 60 ? files : files.slice(0, 30);
      console.log(`[${g}] ${files.length}개`);
      for (const o of shown) console.log(`  ${o.path} | ${o.size} B | ${o.updated.slice(0, 19)}`);
    }
    const hits = all.filter((o) => /pead|prelim|잠정|subset|disclos/i.test(o.path));
    console.log(`\n=== PEAD·잠정실적·부분집합 관련 이름 검색(전 버킷) ===\n${hits.length ? hits.map((o) => `${o.bucket}/${o.path} ${o.size} B`).join("\n") : "해당 객체 없음(Supabase에는 PEAD 전용 객체를 저장한 적이 없다)"}`);
    console.log(`\nSupabase 쓴 행 0 | Storage 쓰기·삭제 0 | 내려받기 0 MiB | 외부 요청 0`);
    return;
  }
  if (MODE === "db") {
    for (const t of ["investor_flow_market", "investor_flow_stock_pilot"] as const) {
      const cnt = async (f?: (q: ReturnType<ReturnType<typeof supabaseAdmin.from>["select"]>) => unknown): Promise<number> => {
        const q = supabaseAdmin.from(t).select("*", { count: "exact", head: true });
        const r = (await (f ? (f(q as never) as PromiseLike<{ count: number | null }>) : q)) as { count: number | null; error?: { message: string } };
        if (r.error) throw new Error(`${t}: ${r.error.message}`);
        return r.count ?? 0;
      };
      console.log(`\n=== ${t} ===\n행 수 ${await cnt()}`);
      const cols = t === "investor_flow_market" ? ["frgn_ntby_amt", "orgn_ntby_amt", "prsn_ntby_amt", "frgn_ntby_qty", "orgn_ntby_qty", "prsn_ntby_qty"] : ["frgn_ntby_amt", "orgn_ntby_amt", "prsn_ntby_amt", "frgn_ntby_qty", "orgn_ntby_qty", "prsn_ntby_qty", "close_price", "volume"];
      const total = await cnt();
      for (const c of cols) console.log(`  ${c} 결측 ${await cnt((q) => (q as unknown as { is: (a: string, b: null) => unknown }).is(c, null))} / ${total}`);
      if (t === "investor_flow_market") {
        for (const m of ["KOSPI", "KOSDAQ"]) {
          const a = await supabaseAdmin.from(t).select("trade_date").eq("market", m).order("trade_date", { ascending: true }).limit(1), b = await supabaseAdmin.from(t).select("trade_date").eq("market", m).order("trade_date", { ascending: false }).limit(1);
          const n = (await supabaseAdmin.from(t).select("*", { count: "exact", head: true }).eq("market", m)).count;
          console.log(`  ${m}: ${n}행 ${a.data?.[0]?.trade_date ?? "-"} ~ ${b.data?.[0]?.trade_date ?? "-"}`);
        }
      } else {
        const rows: { stock_code: string; trade_date: string }[] = [];
        for (let off = 0; ; off += 1000) { const r = await supabaseAdmin.from(t).select("stock_code, trade_date").order("stock_code").order("trade_date").range(off, off + 999); if (r.error) throw new Error(r.error.message); rows.push(...(r.data ?? [])); if ((r.data?.length ?? 0) < 1000) break; }
        const st = new Map<string, [string, string, number]>();
        for (const r of rows) { const v = st.get(r.stock_code) ?? [r.trade_date, r.trade_date, 0]; if (r.trade_date < v[0]) v[0] = r.trade_date; if (r.trade_date > v[1]) v[1] = r.trade_date; v[2]++; st.set(r.stock_code, v); }
        console.log(`  종목 ${st.size}개: ${[...st].map(([k, v]) => `${k} ${v[0]}~${v[1]} ${v[2]}행`).join(" | ")}`);
      }
    }
    console.log(`\nSupabase 쓴 행 0 | Storage 쓰기·삭제 0 | 외부 요청 0`);
    return;
  }
  // read: 수급 Parquet
  let bytes = 0;
  for (const prefix of [INVESTOR_FLOW_STOCK_STORE_PREFIX, INVESTOR_FLOW_STOCK_CLEAN_PREFIX]) {
    console.log(`\n=== ${prefix} (연도별 Parquet) ===\n| 파일 | 크기 MiB | 행 수 | 종목 수 | 기간 | 외국인 금액 결측 % | 기관 금액 결측 % | 개인 금액 결측 % | 외국인 수량 결측 % | 모두 0인 행 % |\n|---|---|---|---|---|---|---|---|---|---|`);
    const { data: ls, error } = await supabaseAdmin.storage.from(INVESTOR_FLOW_STOCK_STORE_BUCKET).list(prefix, { limit: 100 });
    if (error) throw new Error(error.message);
    const files = (ls ?? []).filter((x) => x.name.endsWith(".parquet")).map((x) => x.name).sort();
    let tr = 0;
    const allStocks = new Set<string>();
    for (const f of files) {
      const dl = await supabaseAdmin.storage.from(INVESTOR_FLOW_STOCK_STORE_BUCKET).download(`${prefix}/${f}`);
      if (dl.error || !dl.data) throw new Error(`${prefix}/${f} 실패`);
      bytes += (dl.data as Blob).size;
      const rows = (await parquetReadObjects({ file: await dl.data.arrayBuffer() })) as Record<string, unknown>[];
      const stocks = new Set<string>(); let lo = "9999", hi = "";
      const nul = (k: string): number => rows.filter((r) => r[k] === null || r[k] === undefined || Number.isNaN(r[k] as number)).length;
      let zero = 0;
      for (const r of rows) { stocks.add(String(r.stock_code)); allStocks.add(String(r.stock_code)); const d = String(r.trade_date); if (d < lo) lo = d; if (d > hi) hi = d; if (Number(r.frgn_ntby_amt ?? 0) === 0 && Number(r.orgn_ntby_amt ?? 0) === 0 && Number(r.prsn_ntby_amt ?? 0) === 0) zero++; }
      tr += rows.length;
      console.log(`| ${f} | ${f2((dl.data as Blob).size / MiB)} | ${rows.length} | ${stocks.size} | ${lo}~${hi} | ${f2((nul("frgn_ntby_amt") / Math.max(rows.length, 1)) * 100)} | ${f2((nul("orgn_ntby_amt") / Math.max(rows.length, 1)) * 100)} | ${f2((nul("prsn_ntby_amt") / Math.max(rows.length, 1)) * 100)} | ${f2((nul("frgn_ntby_qty") / Math.max(rows.length, 1)) * 100)} | ${f2((zero / Math.max(rows.length, 1)) * 100)} |`);
    }
    console.log(`${prefix}: 파일 ${files.length}개, 행 합계 ${tr}, 종목 합계(고유) ${allStocks.size}`);
  }
  console.log(`\nStorage 내려받기 합계 ${f2(bytes / MiB)} MiB | Supabase 쓴 행 0 | Storage 쓰기·삭제 0 | 외부 요청 0`);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });
