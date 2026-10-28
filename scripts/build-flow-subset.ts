/**
 * [임시 연구 — 병합 금지] 연구 D5(시도 244)용 수급 부분집합 구축. Supabase Storage의 수급 정리본(research/investor_flow_stock_clean, 17 객체)과 N 연구 보완 파일(research/n_book/kis_flow_fill.parquet)을
 * 이번에 한 번만 읽어 (stock_code, trade_date, frgn_ntby_amt) 세 열만 남긴 Parquet(.research-flow/flow_frgn.parquet)로 저장한다(워크플로가 Actions 캐시 research-flow-subset-20261028로 올린다).
 * 정리본과 보완 파일이 겹치면 정리본 값을 쓴다. 이후 연구는 Supabase에서 다시 읽지 않는다. DB·Storage 쓰기 0, 외부 요청 0, 가격 성과 계산 없음.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { decodeTable, encodeTable, type ColDef, type Row } from "@/lib/nBookStore";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { INVESTOR_FLOW_STOCK_STORE_BUCKET, INVESTOR_FLOW_STOCK_CLEAN_PREFIX } from "@/lib/investorFlowConfig";
import { VGT_STUDY as V } from "@/lib/volumeGapTrendConfig";

const MiB = 1048576;
async function main(): Promise<void> {
  console.log(`수급 부분집합 구축 시작: ${new Date().toISOString()} (Storage 읽기 이번 1회)`);
  let bytes = 0;
  const dl = async (p: string): Promise<Record<string, unknown>[]> => {
    const r = await supabaseAdmin.storage.from(INVESTOR_FLOW_STOCK_STORE_BUCKET).download(p);
    if (r.error || !r.data) throw new Error(`${p} 없음`);
    bytes += (r.data as Blob).size;
    return (await decodeTable(await r.data.arrayBuffer())) as unknown as Record<string, unknown>[];
  };
  const { data: ls, error } = await supabaseAdmin.storage.from(INVESTOR_FLOW_STOCK_STORE_BUCKET).list(INVESTOR_FLOW_STOCK_CLEAN_PREFIX, { limit: 100 });
  if (error) throw new Error(error.message);
  const out = new Map<string, number | null>();
  let nClean = 0, nNull = 0;
  for (const f of (ls ?? []).filter((x) => x.name.endsWith(".parquet")).map((x) => x.name).sort()) {
    for (const r of await dl(`${INVESTOR_FLOW_STOCK_CLEAN_PREFIX}/${f}`)) {
      const v = r.frgn_ntby_amt === null || r.frgn_ntby_amt === undefined || Number.isNaN(Number(r.frgn_ntby_amt)) ? null : Number(r.frgn_ntby_amt);
      out.set(`${r.stock_code}|${r.trade_date}`, v); nClean++; if (v === null) nNull++;
    }
  }
  let nFill = 0, nFillNew = 0;
  for (const r of await dl("research/n_book/kis_flow_fill.parquet")) {
    nFill++;
    const k = `${r.stock_code}|${r.trade_date}`;
    if (out.has(k)) continue;
    const v = r.frgn_ntby_amt === null || r.frgn_ntby_amt === undefined || Number.isNaN(Number(r.frgn_ntby_amt)) ? null : Number(r.frgn_ntby_amt);
    out.set(k, v); nFillNew++;
  }
  const rows: Row[] = [...out].map(([k, v]) => { const [c, d] = k.split("|"); return { stock_code: c, trade_date: d, frgn_ntby_amt: v }; }).sort((a, b) => (String(a.stock_code) + String(a.trade_date) < String(b.stock_code) + String(b.trade_date) ? -1 : 1));
  const cols: ColDef[] = [{ name: "stock_code", type: "STRING" }, { name: "trade_date", type: "STRING" }, { name: "frgn_ntby_amt", type: "DOUBLE" }];
  const body = new Uint8Array(encodeTable(cols, rows));
  await fs.mkdir(V.flowDir, { recursive: true });
  await fs.writeFile(path.join(V.flowDir, V.flowFile), body);
  const sha = createHash("sha256").update(body).digest("hex");
  await fs.writeFile(path.join(V.flowDir, "manifest.json"), JSON.stringify({ builtAt: new Date().toISOString(), rows: rows.length, cleanRows: nClean, cleanNull: nNull, fillRows: nFill, fillNew: nFillNew, sha256: sha }, null, 1));
  console.log(`정리본 ${nClean}행(외국인 금액 결측 ${nNull}), 보완 파일 ${nFill}행 중 새 종목-일 ${nFillNew}행 → 합계 ${rows.length}행, 종목 ${new Set(rows.map((r) => r.stock_code)).size}개`);
  console.log(`저장 ${path.join(V.flowDir, V.flowFile)} ${body.byteLength} B (${(body.byteLength / MiB).toFixed(2)} MiB) SHA-256 ${sha}`);
  console.log(`\nStorage 내려받기 합계 ${(bytes / MiB).toFixed(2)} MiB(이번 1회) | Supabase 쓴 행 0 | Storage 쓰기 0 | 외부 요청 0 | 가격 성과 계산 없음 | 시도 번호 소진 없음`);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });
