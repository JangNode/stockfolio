/**
 * [연구용] 연구 N 수집 결과 저장 도우미: Supabase Storage(버킷 stock-daily-prices, research/n_book/) Parquet(zstd) 읽기·쓰기와 진행 파일.
 * DB 쓰기 없음. 압축은 Node 내장 zlib zstd를 hyparquet(-writer) 압축기로 연결한다. 키 값은 다루지 않는다.
 */
import zlib from "node:zlib";
import { parquetReadObjects } from "hyparquet";
import { parquetWriteBuffer } from "hyparquet-writer";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { INVESTOR_FLOW_STOCK_STORE_BUCKET } from "@/lib/investorFlowConfig";
import { N_STORE_PREFIX } from "@/lib/kodexSectorSatConfig";

export type Cell = string | number | null;
export type Row = Record<string, Cell>;
export interface ColDef { name: string; type: "STRING" | "DOUBLE" }

const zstdCompress = (input: Uint8Array): Uint8Array => new Uint8Array((zlib as unknown as { zstdCompressSync: (b: Uint8Array) => Buffer }).zstdCompressSync(input));
const zstdDecompress = (input: Uint8Array): Uint8Array => new Uint8Array((zlib as unknown as { zstdDecompressSync: (b: Uint8Array) => Buffer }).zstdDecompressSync(input));

export const nBucket = (): ReturnType<typeof supabaseAdmin.storage.from> => supabaseAdmin.storage.from(INVESTOR_FLOW_STOCK_STORE_BUCKET);
export const nPath = (name: string): string => `${N_STORE_PREFIX}/${name}`;

export function encodeTable(cols: ColDef[], rows: Row[]): ArrayBuffer {
  return parquetWriteBuffer({
    codec: "ZSTD",
    compressors: { ZSTD: zstdCompress },
    columnData: cols.map((c) => ({ name: c.name, type: c.type, nullable: true, data: rows.map((r) => (r[c.name] === undefined ? null : r[c.name])) as never })),
  });
}
export async function decodeTable(buf: ArrayBuffer): Promise<Row[]> {
  const rows = (await parquetReadObjects({ file: buf, compressors: { ZSTD: (input: Uint8Array) => zstdDecompress(input) } as never })) as Row[];
  return rows.map((r) => { const o: Row = {}; for (const [k, v] of Object.entries(r)) o[k] = typeof v === "bigint" ? Number(v) : (v as Cell); return o; });
}
export async function downloadBuf(path: string): Promise<ArrayBuffer | null> {
  const { data, error } = await nBucket().download(path);
  if (error) { if (/not found|404|Object not found/i.test(error.message)) return null; throw new Error(`Storage 다운로드 실패 ${path}: ${error.message}`); }
  return data.arrayBuffer();
}
export async function uploadBuf(path: string, body: ArrayBuffer | Uint8Array): Promise<void> {
  const { error } = await nBucket().upload(path, body, { contentType: "application/octet-stream", upsert: true });
  if (error) throw new Error(`Storage 업로드 실패 ${path}: ${error.message}`);
}
export async function readTable(name: string): Promise<Row[]> {
  const b = await downloadBuf(nPath(name));
  return b ? decodeTable(b) : [];
}
export async function writeTable(name: string, cols: ColDef[], rows: Row[]): Promise<number> {
  const buf = encodeTable(cols, rows);
  await uploadBuf(nPath(name), buf);
  return buf.byteLength;
}
export async function readJson<T>(name: string, fallback: T): Promise<T> {
  const b = await downloadBuf(nPath(name));
  return b ? (JSON.parse(new TextDecoder().decode(b)) as T) : fallback;
}
export async function writeJson(name: string, v: unknown): Promise<void> {
  await uploadBuf(nPath(name), new TextEncoder().encode(JSON.stringify(v)));
}

/** 전 버킷 파일 크기 합계(바이트)와 research/n_book/ 아래 합계. 읽기 전용. */
export async function storageUsage(): Promise<{ perBucket: { bucket: string; bytes: number; files: number }[]; total: number; nBook: number }> {
  const { data: buckets, error } = await supabaseAdmin.storage.listBuckets();
  if (error) throw new Error(`버킷 목록 실패: ${error.message}`);
  const perBucket: { bucket: string; bytes: number; files: number }[] = [];
  let nBook = 0;
  for (const b of buckets ?? []) {
    let bytes = 0, files = 0;
    const walk = async (prefix: string): Promise<void> => {
      for (let offset = 0; ; offset += 1000) {
        const { data, error: e2 } = await supabaseAdmin.storage.from(b.name).list(prefix, { limit: 1000, offset });
        if (e2) throw new Error(`목록 실패 ${b.name}/${prefix}: ${e2.message}`);
        for (const it of data ?? []) {
          const p = prefix ? `${prefix}/${it.name}` : it.name;
          if (it.id === null) await walk(p);
          else { const sz = Number((it.metadata as { size?: number } | null)?.size ?? 0); bytes += sz; files++; if (b.name === INVESTOR_FLOW_STOCK_STORE_BUCKET && p.startsWith(`${N_STORE_PREFIX}/`)) nBook += sz; }
        }
        if ((data?.length ?? 0) < 1000) break;
      }
    };
    await walk("");
    perBucket.push({ bucket: b.name, bytes, files });
  }
  return { perBucket, total: perBucket.reduce((a, x) => a + x.bytes, 0), nBook };
}
export const MiB = 1048576;
export const kstDate = (d = new Date()): string => new Date(d.getTime() + 9 * 3600e3).toISOString().slice(0, 10);
export const kstTime = (d = new Date()): string => new Date(d.getTime() + 9 * 3600e3).toISOString().slice(11, 19);
