import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Supabase Storage의 연도별 Parquet 가격 파일(lib/stockDailyPricesStorage.ts)을 실행마다 전부 다시
 * 받지 않도록 하는 디스크 캐시. PARQUET_CACHE_DIR 환경변수가 있을 때만 켜지고(배치/연구용
 * GitHub Actions 워크플로), 없으면 예전과 똑같이 매번 다운로드한다(웹 서버리스·로컬은 영향 없음).
 *
 * 변경 판별: 받기 전에 Storage list API(가벼운 JSON)로 파일 메타데이터(eTag·size·updated_at)를 조회해
 * 캐시에 저장해 둔 값과 비교한다. 같으면 디스크에서 읽고, 다르거나 판별값을 얻을 수 없으면 다시 받는다
 * (불확실하면 항상 다운로드 쪽 = 안전 쪽).
 */

export interface ParquetCacheStats {
  hits: number;
  hitBytes: number;
  downloads: number;
  downloadBytes: number;
}

export const parquetCacheStats: ParquetCacheStats = { hits: 0, hitBytes: 0, downloads: 0, downloadBytes: 0 };

export interface YearFingerprint {
  /** 파일이 바뀌면 달라지는 값. */
  fingerprint: string;
  /** 알면 다운로드 직후 바이트 수와 대조한다(조회와 다운로드 사이에 파일이 바뀐 경우를 걸러냄). */
  size?: number;
}

export interface YearFileSource {
  /** 변경 판별값. 얻을 수 없으면 null(= 캐시를 쓰지도 저장하지도 않고 다운로드). */
  getFingerprint(): Promise<YearFingerprint | null>;
  /** 파일 전체. 파일이 없으면 null. */
  download(): Promise<ArrayBuffer | null>;
}

interface CacheMeta {
  fingerprint: string;
  size: number;
}

const DIRTY_MARKER = ".dirty";

const MB = 1024 * 1024;
const fmtMb = (bytes: number): string => (bytes / MB).toFixed(2);

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

async function writeAtomic(target: string, data: Uint8Array | string): Promise<void> {
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, target);
}

async function readCached(dir: string, fileName: string, fingerprint: string): Promise<ArrayBuffer | null> {
  try {
    const meta = JSON.parse(await fs.readFile(path.join(dir, `${fileName}.meta.json`), "utf8")) as CacheMeta;
    if (meta.fingerprint !== fingerprint) return null;
    const data = await fs.readFile(path.join(dir, fileName));
    if (data.byteLength !== meta.size) return null; // 쓰다 만 파일·손상
    return toArrayBuffer(data);
  } catch {
    return null; // 캐시 없음/읽기 실패 -> 미스로 처리
  }
}

/**
 * fileName(예: 2024.parquet)의 내용을 돌려준다. cacheDir이 없으면 항상 source.download().
 * 있으면 판별값이 캐시와 같을 때만 디스크에서 읽는다.
 */
export async function readThroughDiskCache(opts: {
  cacheDir: string | undefined;
  fileName: string;
  source: YearFileSource;
  stats?: ParquetCacheStats;
  log?: (message: string) => void;
}): Promise<ArrayBuffer | null> {
  const { cacheDir, fileName, source } = opts;
  const stats = opts.stats ?? parquetCacheStats;
  const log = opts.log ?? (() => {});

  if (!cacheDir) {
    const buf = await source.download();
    if (buf) {
      stats.downloads++;
      stats.downloadBytes += buf.byteLength;
    }
    return buf;
  }

  let fp: YearFingerprint | null = null;
  try {
    fp = await source.getFingerprint();
  } catch {
    fp = null; // 메타데이터 조회 실패 -> 판별 불가 -> 다운로드
  }

  if (fp) {
    const cached = await readCached(cacheDir, fileName, fp.fingerprint);
    if (cached) {
      stats.hits++;
      stats.hitBytes += cached.byteLength;
      log(`[parquet-cache] ${fileName} 캐시 적중 ${fmtMb(cached.byteLength)} MB`);
      return cached;
    }
  }

  const buf = await source.download();
  if (!buf) return null;
  stats.downloads++;
  stats.downloadBytes += buf.byteLength;

  let storedNote = "캐시 저장 안 함: 판별값 없음";
  if (fp) {
    if (fp.size !== undefined && fp.size !== buf.byteLength) {
      storedNote = "캐시 저장 안 함: 조회 후 파일이 바뀐 것으로 보임";
    } else {
      try {
        await fs.mkdir(cacheDir, { recursive: true });
        await writeAtomic(path.join(cacheDir, fileName), new Uint8Array(buf));
        // meta는 데이터 파일을 다 쓴 뒤에 쓴다(중간에 끊겨도 meta만 있고 데이터가 없는 상태는 검증에서 걸러짐).
        await writeAtomic(
          path.join(cacheDir, `${fileName}.meta.json`),
          JSON.stringify({ fingerprint: fp.fingerprint, size: buf.byteLength } satisfies CacheMeta)
        );
        await fs.writeFile(path.join(cacheDir, DIRTY_MARKER), "1");
        storedNote = "캐시에 저장";
      } catch (error) {
        storedNote = `캐시 저장 실패(무시): ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }
  log(`[parquet-cache] ${fileName} 다운로드 ${fmtMb(buf.byteLength)} MB (${storedNote})`);
  return buf;
}

/** list API가 돌려주는 파일 항목에서 변경 판별값을 만든다. 판별에 충분하지 않으면 null. */
export function buildFingerprint(entry: {
  id?: string | null;
  updated_at?: string | null;
  metadata?: { eTag?: string; size?: number; lastModified?: string } | null;
}): YearFingerprint | null {
  const meta = entry.metadata;
  const size = typeof meta?.size === "number" ? meta.size : undefined;
  if (size === undefined) return null;
  const etag = meta?.eTag || "";
  const modified = entry.updated_at || meta?.lastModified || "";
  // eTag가 없으면 수정 시각이 있어야 한다. 둘 다 없으면 판별 불가.
  if (!etag && !modified) return null;
  return { fingerprint: `etag=${etag};size=${size};modified=${modified};id=${entry.id ?? ""}`, size };
}

export function formatParquetCacheSummary(stats: ParquetCacheStats, cacheEnabled: boolean): string | null {
  if (stats.hits + stats.downloads === 0) return null;
  if (!cacheEnabled) return `[parquet-cache] 캐시 비활성(PARQUET_CACHE_DIR 없음): 다운로드 ${stats.downloads}건 ${fmtMb(stats.downloadBytes)} MB`;
  return `[parquet-cache] 연도별 캐시 적중 ${stats.hits}건(${fmtMb(stats.hitBytes)} MB 절약), 다운로드 ${stats.downloads}건 ${fmtMb(stats.downloadBytes)} MB`;
}

let exitHookRegistered = false;
/** 프로세스 종료 시 요약 한 줄을 남긴다(여러 번 불러도 한 번만 등록). */
export function registerParquetCacheSummaryOnExit(cacheEnabled: () => boolean): void {
  if (exitHookRegistered) return;
  exitHookRegistered = true;
  process.on("exit", () => {
    const line = formatParquetCacheSummary(parquetCacheStats, cacheEnabled());
    if (line) console.log(line);
  });
}
