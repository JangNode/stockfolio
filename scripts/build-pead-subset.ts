/**
 * [임시 연구 — 병합 금지] 연구 PEAD 잠정실적(PE7)용 부분집합 구축. Supabase Storage의 fin.parquet·filings.parquet·월말 시장 목록을 이번에 한 번만 읽어 필요한 열만 남긴 뒤
 * .research-subset/에 저장한다(워크플로가 Actions 캐시 research-subset-20261028로 올린다). 이후 연구는 Storage에서 다시 읽지 않는다. DB·Storage 쓰기 0, 외부 요청 0.
 * 남기는 것: fin = 상태 orig 행의 키·접수 정보·영업이익 4열(순이익·자본은 PE7 이벤트에 쓰이지 않아 뺀다), filings = 키·접수일·정정 구분·보고서명 전체 행, 월말 목록 = 원본 바이트 그대로.
 * 이벤트(분기 영업이익·전년 동기)가 원본 fin·filings로 만든 것과 완전히 같음을 확인한 뒤에만 저장한다.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { downloadBuf, decodeTable, encodeTable, type ColDef, type Row } from "@/lib/nBookStore";
import { eventsByCorp, type FinRow, type FilingRow } from "@/lib/rFinMetrics";
import { R_STORE_PREFIX } from "@/lib/kodexSectorSatConfig";
import { MM_PARQUET_PATH } from "@/lib/marketMembershipConfig";
import { PEAD_PRELIM_STUDY as S } from "@/lib/peadConfig";

const sha = (b: Uint8Array | ArrayBuffer): string => createHash("sha256").update(b instanceof ArrayBuffer ? new Uint8Array(b) : b).digest("hex");
const MiB = 1048576;
const str = (n: string): ColDef => ({ name: n, type: "STRING" });
const num = (n: string): ColDef => ({ name: n, type: "DOUBLE" });

async function main(): Promise<void> {
  console.log(`연구 PEAD 잠정실적 부분집합 구축 시작: ${new Date().toISOString()} (Storage 읽기 이번 1회)`);
  let bytes = 0;
  const dl = async (p: string): Promise<ArrayBuffer> => { const b = await downloadBuf(p); if (!b) throw new Error(`${p} 없음`); bytes += b.byteLength; return b; };
  const finBuf = await dl(`${R_STORE_PREFIX}/fin.parquet`), filBuf = await dl(`${R_STORE_PREFIX}/filings.parquet`), mmBuf = await dl(MM_PARQUET_PATH);
  console.log(`내려받음: fin ${(finBuf.byteLength / MiB).toFixed(2)} MiB, filings ${(filBuf.byteLength / MiB).toFixed(2)} MiB, 월말 목록 ${(mmBuf.byteLength / MiB).toFixed(2)} MiB | 합계 ${(bytes / MiB).toFixed(2)} MiB | 원본 SHA-256 fin ${sha(finBuf)} filings ${sha(filBuf)} 월말 ${sha(mmBuf)}`);
  const fin = (await decodeTable(finBuf)) as unknown as FinRow[], fil = (await decodeTable(filBuf)) as unknown as FilingRow[];
  console.log(`원본 행: fin ${fin.length}, filings ${fil.length}`);

  const finSub: Row[] = [];
  for (const r of fin) if (r.status === "orig") finSub.push({ corp_code: r.corp_code, stock_code: r.stock_code, bsns_year: r.bsns_year, reprt_code: r.reprt_code, fs_div: r.fs_div, rcept_no: r.rcept_no, rcept_dt: r.rcept_dt, status: r.status, oi_c: r.oi_c, oi_a: r.oi_a, oi_p: r.oi_p, oi_pa: r.oi_pa });
  const filSub: Row[] = fil.map((r) => ({ corp_code: r.corp_code, rcept_no: r.rcept_no, rcept_dt: r.rcept_dt, correction: r.correction, report_nm: r.report_nm }));
  const finSubRows = finSub.map((r) => ({ ...r, ni_c: null, ni_a: null, ni_p: null, ni_pa: null, eq_c: null, eq_p: null })) as unknown as FinRow[];

  // 이벤트 동일성: 원본으로 만든 이벤트와 부분집합으로 만든 이벤트의 (회사, 접수번호, 접수일, 분기 영업이익, 전년 동기)가 같아야 한다.
  const sig = (m: Map<string, { rceptNo: string; rceptDt: string; qOi: number | null; qOiPrev: number | null }[]>): string => {
    const h = createHash("sha256");
    let n = 0, nv = 0;
    for (const c of [...m.keys()].sort()) for (const e of m.get(c)!) { h.update(`${c}|${e.rceptNo}|${e.rceptDt}|${e.qOi}|${e.qOiPrev}\n`); n++; if (e.qOi !== null && e.qOiPrev !== null) nv++; }
    return `${h.digest("hex")} (이벤트 ${n}건, 분기 영업이익·전년 동기 값 있는 ${nv}건)`;
  };
  const a = sig(eventsByCorp(fin, fil)), b = sig(eventsByCorp(finSubRows, fil));
  console.log(`이벤트 동일성: 원본 ${a}\n               부분집합 ${b} → ${a === b ? "일치" : "불일치"}`);
  if (a !== b) throw new Error("부분집합 이벤트가 원본과 다르다 — 저장하지 않는다");

  const finCols = [str("corp_code"), str("stock_code"), str("bsns_year"), str("reprt_code"), str("fs_div"), str("rcept_no"), str("rcept_dt"), str("status"), num("oi_c"), num("oi_a"), num("oi_p"), num("oi_pa")];
  const filCols = [str("corp_code"), str("rcept_no"), str("rcept_dt"), str("correction"), str("report_nm")];
  const files: [string, Uint8Array][] = [["fin_sub.parquet", new Uint8Array(encodeTable(finCols, finSub))], ["filings_sub.parquet", new Uint8Array(encodeTable(filCols, filSub))], ["month_end.parquet", new Uint8Array(mmBuf)]];
  await fs.mkdir(S.subsetDir, { recursive: true });
  const manifest: Record<string, { bytes: number; sha256: string; rows?: number }> = {};
  for (const [name, body] of files) { await fs.writeFile(path.join(S.subsetDir, name), body); manifest[name] = { bytes: body.byteLength, sha256: sha(body), rows: name === "fin_sub.parquet" ? finSub.length : name === "filings_sub.parquet" ? filSub.length : undefined }; }
  await fs.writeFile(path.join(S.subsetDir, "manifest.json"), JSON.stringify({ builtAt: new Date().toISOString(), source: "Supabase Storage research/r_allcap/{fin,filings}.parquet + research/market_membership/month_end.parquet", eventSignature: b, files: manifest }, null, 1));
  console.log(`\n부분집합 저장(${S.subsetDir}):\n${Object.entries(manifest).map(([k, v]) => `  ${k} ${v.bytes} B (${(v.bytes / MiB).toFixed(2)} MiB)${v.rows !== undefined ? ` ${v.rows}행` : ""} SHA-256 ${v.sha256}`).join("\n")}`);
  console.log(`\nStorage 내려받기 합계 ${(bytes / MiB).toFixed(2)} MiB(이번 1회) | Supabase 쓴 행 0 | Storage 쓰기 0 | 외부 요청 0 | 시도 번호 소진 없음`);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });
