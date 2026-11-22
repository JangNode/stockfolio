/**
 * [임시 연구 — 병합 금지] 연구 자료 파일(재무 fin.parquet, 월말 시장 목록 등)을 Actions 캐시 디렉터리에 두고 Storage 읽기를 줄이는 읽기 전용 캐시.
 * RESEARCH_CACHE_DIR가 있을 때만 쓴다(없으면 항상 Storage에서 읽음 = 기존 동작). 파일은 이름으로만 구분하는 불변 자료용이다:
 * 원본이 바뀌면 워크플로 캐시 키 버전(research-files-v1 → v2)을 올려야 한다. 캐시가 7일 미사용으로 만료되면 첫 실행이 Storage에서 다시 읽고 다시 저장한다.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

export const researchCacheStats = { hits: 0, hitBytes: 0, misses: 0, missBytes: 0, files: [] as { name: string; bytes: number; hit: boolean }[] };

const dirOf = (): string | undefined => process.env.RESEARCH_CACHE_DIR?.trim() || undefined;
const safe = (name: string): string => name.replace(/[\\/]/g, "__");

/** 캐시에 있으면 디스크에서, 없으면 fetcher(Storage 내려받기)로 읽고 캐시 디렉터리에 저장한다. null(파일 없음)은 저장하지 않는다. */
export async function cachedBytes(name: string, fetcher: () => Promise<ArrayBuffer | null>): Promise<ArrayBuffer | null> {
  const dir = dirOf();
  if (dir) {
    try {
      const b = await fs.readFile(path.join(dir, safe(name)));
      researchCacheStats.hits++; researchCacheStats.hitBytes += b.byteLength; researchCacheStats.files.push({ name, bytes: b.byteLength, hit: true });
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    } catch { /* 캐시 미스 */ }
  }
  const b = await fetcher();
  if (!b) return null;
  researchCacheStats.misses++; researchCacheStats.missBytes += b.byteLength; researchCacheStats.files.push({ name, bytes: b.byteLength, hit: false });
  if (dir) {
    await fs.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `${safe(name)}.tmp`);
    await fs.writeFile(tmp, Buffer.from(b));
    await fs.rename(tmp, path.join(dir, safe(name)));
    await fs.writeFile(path.join(dir, ".dirty"), "1");
  }
  return b;
}

export const researchCacheLine = (): string => `연구 자료 파일(재무·월말 목록 등) 캐시 ${dirOf() ? "사용" : "미사용(Storage 직접)"}: 적중 ${researchCacheStats.hits}건 ${(researchCacheStats.hitBytes / 1048576).toFixed(2)} MiB(전송 0) · Storage 다운로드 ${researchCacheStats.misses}건 ${(researchCacheStats.missBytes / 1048576).toFixed(2)} MiB${researchCacheStats.files.length ? ` [${researchCacheStats.files.map((f) => `${f.name.split("/").pop()} ${(f.bytes / 1048576).toFixed(2)}${f.hit ? "(적중)" : "(다운)"}`).join(", ")}]` : ""}`;
