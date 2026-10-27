/**
 * [임시 연구 — 병합 금지] 연구용 가격 Parquet 스냅샷 점검·매니페스트 작성(읽기 전용, Supabase 요청 0건).
 * PARQUET_CACHE_DIR에 복원된 2010~2026 연도 파일의 크기·SHA-256·행 수·날짜 범위를 기록하고(snapshot.json),
 * 2026 파일의 마지막 거래일이 SNAP_EXPECTED_END와 같지 않으면 실패한다. 통과하면 워크플로가 이 폴더를 고정 키로 저장한다.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { parquetReadObjects } from "hyparquet";

const MIB = 1048576;

async function main(): Promise<void> {
  const dir = process.env.PARQUET_CACHE_DIR?.trim();
  const expectedEnd = process.env.SNAP_EXPECTED_END?.trim();
  if (!dir || !expectedEnd) throw new Error("PARQUET_CACHE_DIR, SNAP_EXPECTED_END 필요");
  const files: { year: number; bytes: number; sha256: string; rows: number; minDate: string; maxDate: string }[] = [];
  for (let year = 2010; year <= Number(expectedEnd.slice(0, 4)); year++) {
    const buf = await fs.readFile(path.join(dir, `${year}.parquet`));
    const rows = (await parquetReadObjects({ file: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer })) as { trade_date: string }[];
    let minDate = "9999-99-99", maxDate = "";
    for (const r of rows) { if (r.trade_date < minDate) minDate = r.trade_date; if (r.trade_date > maxDate) maxDate = r.trade_date; }
    files.push({ year, bytes: buf.byteLength, sha256: createHash("sha256").update(buf).digest("hex"), rows: rows.length, minDate, maxDate });
    console.log(`${year}.parquet ${(buf.byteLength / MIB).toFixed(2)} MiB 행 ${rows.length} ${minDate}~${maxDate} sha256 ${files[files.length - 1].sha256.slice(0, 16)}…`);
  }
  const last = files[files.length - 1];
  if (last.maxDate !== expectedEnd) throw new Error(`${last.year}.parquet 마지막 거래일 ${last.maxDate} ≠ 기대 ${expectedEnd} — 스냅샷으로 고정하지 않는다`);
  const total = files.reduce((a, f) => a + f.bytes, 0);
  await fs.writeFile(path.join(dir, "snapshot.json"), JSON.stringify({ dataEnd: expectedEnd, createdAt: new Date().toISOString(), files }, null, 1));
  console.log(`스냅샷 점검 통과: 데이터 종료일 ${expectedEnd}, 파일 ${files.length}개 합계 ${(total / MIB).toFixed(2)} MiB | Supabase 요청 0 | Storage 내려받기 0.00 MiB`);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });
