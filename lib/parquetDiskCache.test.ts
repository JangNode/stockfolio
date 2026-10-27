import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parquetWriteBuffer } from "hyparquet-writer";
import {
  buildFingerprint,
  formatParquetCacheSummary,
  readThroughDiskCache,
  type ParquetCacheStats,
  type YearFingerprint,
} from "@/lib/parquetDiskCache";
import { parseYearPricesParquet } from "@/lib/stockDailyPricesParquet";

const newStats = (): ParquetCacheStats => ({ hits: 0, hitBytes: 0, downloads: 0, downloadBytes: 0 });

function bytes(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}
const asText = (buf: ArrayBuffer | null): string | null => (buf ? new TextDecoder().decode(buf) : null);

function fakeSource(content: string | null, fp: YearFingerprint | null | "throw") {
  const calls = { fingerprint: 0, download: 0 };
  return {
    calls,
    source: {
      getFingerprint: async () => {
        calls.fingerprint++;
        if (fp === "throw") throw new Error("list failed");
        return fp;
      },
      download: async () => {
        calls.download++;
        return content === null ? null : bytes(content);
      },
    },
  };
}

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "parquet-cache-test-"));
}

test("환경변수 없음(cacheDir 없음): 매번 다운로드하고 메타데이터 조회·파일 쓰기가 없다", async () => {
  const stats = newStats();
  const { calls, source } = fakeSource("AAAA", { fingerprint: "f1", size: 4 });
  const a = await readThroughDiskCache({ cacheDir: undefined, fileName: "2020.parquet", source, stats });
  const b = await readThroughDiskCache({ cacheDir: undefined, fileName: "2020.parquet", source, stats });
  assert.equal(asText(a), "AAAA");
  assert.equal(asText(b), "AAAA");
  assert.equal(calls.download, 2);
  assert.equal(calls.fingerprint, 0);
  assert.deepEqual(stats, { hits: 0, hitBytes: 0, downloads: 2, downloadBytes: 8 });
});

test("캐시 미스 -> 다운로드 후 저장, 같은 판별값이면 다음엔 적중(다운로드 없음)", async () => {
  const dir = await tempDir();
  const stats = newStats();
  const logs: string[] = [];
  const fp: YearFingerprint = { fingerprint: "f1", size: 4 };
  const first = fakeSource("AAAA", fp);
  const r1 = await readThroughDiskCache({ cacheDir: dir, fileName: "2020.parquet", source: first.source, stats, log: (m) => logs.push(m) });
  assert.equal(asText(r1), "AAAA");
  assert.equal(first.calls.download, 1);
  assert.deepEqual(await fs.readdir(dir).then((n) => n.sort()), [".dirty", "2020.parquet", "2020.parquet.meta.json"]);

  const second = fakeSource("AAAA", fp);
  const r2 = await readThroughDiskCache({ cacheDir: dir, fileName: "2020.parquet", source: second.source, stats, log: (m) => logs.push(m) });
  assert.equal(asText(r2), "AAAA");
  assert.equal(second.calls.download, 0, "적중이면 다운로드하지 않는다");
  assert.equal(second.calls.fingerprint, 1);
  assert.deepEqual(stats, { hits: 1, hitBytes: 4, downloads: 1, downloadBytes: 4 });
  assert.ok(logs[0].includes("다운로드") && logs[1].includes("캐시 적중"));
});

test("판별값 불일치 -> 다시 다운로드하고 새 값으로 교체, 이후 새 값으로 적중", async () => {
  const dir = await tempDir();
  const stats = newStats();
  await readThroughDiskCache({ cacheDir: dir, fileName: "2020.parquet", source: fakeSource("AAAA", { fingerprint: "f1", size: 4 }).source, stats });

  const changed = fakeSource("BBBBBB", { fingerprint: "f2", size: 6 });
  const r = await readThroughDiskCache({ cacheDir: dir, fileName: "2020.parquet", source: changed.source, stats });
  assert.equal(asText(r), "BBBBBB");
  assert.equal(changed.calls.download, 1);

  const again = fakeSource("BBBBBB", { fingerprint: "f2", size: 6 });
  const r2 = await readThroughDiskCache({ cacheDir: dir, fileName: "2020.parquet", source: again.source, stats });
  assert.equal(asText(r2), "BBBBBB");
  assert.equal(again.calls.download, 0);
});

test("안전 쪽 동작: 판별값 없음/조회 실패/캐시 손상/조회와 다운로드 사이 크기 변경이면 다운로드하고 잘못된 캐시를 만들지 않는다", async () => {
  // 판별값 없음(null): 저장하지 않으므로 두 번 다 다운로드
  const dir1 = await tempDir();
  const s1 = fakeSource("AAAA", null);
  await readThroughDiskCache({ cacheDir: dir1, fileName: "2020.parquet", source: s1.source, stats: newStats() });
  await readThroughDiskCache({ cacheDir: dir1, fileName: "2020.parquet", source: s1.source, stats: newStats() });
  assert.equal(s1.calls.download, 2);
  assert.deepEqual(await fs.readdir(dir1), []);

  // 조회 실패(throw): 다운로드
  const dir2 = await tempDir();
  const s2 = fakeSource("AAAA", "throw");
  assert.equal(asText(await readThroughDiskCache({ cacheDir: dir2, fileName: "2020.parquet", source: s2.source, stats: newStats() })), "AAAA");
  assert.equal(s2.calls.download, 1);

  // 캐시 데이터 파일 손상(크기 불일치) -> 미스
  const dir3 = await tempDir();
  const fp: YearFingerprint = { fingerprint: "f1", size: 4 };
  await readThroughDiskCache({ cacheDir: dir3, fileName: "2020.parquet", source: fakeSource("AAAA", fp).source, stats: newStats() });
  await fs.writeFile(path.join(dir3, "2020.parquet"), "AA");
  const s3 = fakeSource("AAAA", fp);
  assert.equal(asText(await readThroughDiskCache({ cacheDir: dir3, fileName: "2020.parquet", source: s3.source, stats: newStats() })), "AAAA");
  assert.equal(s3.calls.download, 1);

  // 메타 파일 손상 -> 미스
  await fs.writeFile(path.join(dir3, "2020.parquet.meta.json"), "{not json");
  const s3b = fakeSource("AAAA", fp);
  await readThroughDiskCache({ cacheDir: dir3, fileName: "2020.parquet", source: s3b.source, stats: newStats() });
  assert.equal(s3b.calls.download, 1);

  // 조회한 크기와 받은 크기가 다름(그 사이 파일이 바뀜) -> 저장 안 함
  const dir4 = await tempDir();
  const s4 = fakeSource("AAAAAA", { fingerprint: "f1", size: 4 });
  await readThroughDiskCache({ cacheDir: dir4, fileName: "2020.parquet", source: s4.source, stats: newStats() });
  assert.deepEqual(await fs.readdir(dir4), []);

  // 파일 없음 -> null, 저장 없음
  const dir5 = await tempDir();
  const s5 = fakeSource(null, { fingerprint: "f1", size: 4 });
  assert.equal(await readThroughDiskCache({ cacheDir: dir5, fileName: "2031.parquet", source: s5.source, stats: newStats() }), null);
  assert.deepEqual(await fs.readdir(dir5), []);
});

test("캐시에서 읽은 파일과 새로 받은 파일은 같은 파싱 결과를 낸다", async () => {
  const columnData = [
    { name: "stock_code", data: ["005930", "000660"], type: "STRING" as const },
    { name: "trade_date", data: ["2024-01-02", "2024-01-02"], type: "STRING" as const },
    { name: "close_price", data: [78000, 150000], type: "DOUBLE" as const },
    { name: "market_cap_eok", data: [4650000, 1090000], type: "DOUBLE" as const },
    { name: "listed_shares", data: [5969782550, 728002365], type: "DOUBLE" as const },
  ];
  const parquet = parquetWriteBuffer({ columnData });
  const dir = await tempDir();
  const fp: YearFingerprint = { fingerprint: "f1", size: parquet.byteLength };
  const src = () => ({ getFingerprint: async () => fp, download: async () => parquet });
  const fresh = await readThroughDiskCache({ cacheDir: dir, fileName: "2024.parquet", source: src(), stats: newStats() });
  const cached = await readThroughDiskCache({ cacheDir: dir, fileName: "2024.parquet", source: { getFingerprint: async () => fp, download: async () => { throw new Error("적중이어야 함"); } }, stats: newStats() });
  const noCache = await readThroughDiskCache({ cacheDir: undefined, fileName: "2024.parquet", source: src(), stats: newStats() });
  const a = await parseYearPricesParquet(fresh!);
  const b = await parseYearPricesParquet(cached!);
  const c = await parseYearPricesParquet(noCache!);
  assert.deepEqual(b, a);
  assert.deepEqual(c, a);
  assert.equal(a.length, 2);
  assert.equal(a[0].openPrice, 0); // 옛 파일에 없는 컬럼은 0
});

test("buildFingerprint: eTag·size가 있으면 만들고, 크기가 없거나 eTag·수정시각이 모두 없으면 null", () => {
  assert.deepEqual(
    buildFingerprint({ id: "x", updated_at: "2026-10-06T00:00:00Z", metadata: { eTag: '"abc"', size: 100 } }),
    { fingerprint: 'etag="abc";size=100;modified=2026-10-06T00:00:00Z;id=x', size: 100 }
  );
  assert.notEqual(buildFingerprint({ updated_at: "t", metadata: { size: 1 } }), null); // eTag 없어도 수정시각+크기면 허용
  assert.equal(buildFingerprint({ metadata: { eTag: "e" } }), null); // 크기 없음
  assert.equal(buildFingerprint({ metadata: { size: 1 } }), null); // eTag·수정시각 없음
  assert.equal(buildFingerprint({ metadata: null }), null);
});

test("formatParquetCacheSummary: 적중/다운로드 요약 문구", () => {
  const stats = { hits: 15, hitBytes: 200 * 1048576, downloads: 2, downloadBytes: 30 * 1048576 };
  assert.equal(formatParquetCacheSummary(stats, true), "[parquet-cache] 연도별 캐시 적중 15건(200.00 MB 절약), 다운로드 2건 30.00 MB");
  assert.ok(formatParquetCacheSummary(stats, false)!.includes("캐시 비활성"));
  assert.equal(formatParquetCacheSummary({ hits: 0, hitBytes: 0, downloads: 0, downloadBytes: 0 }, true), null);
});

test("고정 스냅샷 모드(PARQUET_CACHE_FROZEN=1): 판별값이 달라도 디스크 파일을 그대로 읽고, 파일이 없으면 받지 않고 실패한다", async () => {
  const dir = await tempDir();
  await fs.writeFile(path.join(dir, "2026.parquet"), "SNAP");
  const prev = process.env.PARQUET_CACHE_FROZEN;
  process.env.PARQUET_CACHE_FROZEN = "1";
  try {
    const stats = newStats();
    const { calls, source } = fakeSource("NEWER-FILE", { fingerprint: "changed", size: 10 });
    const buf = await readThroughDiskCache({ cacheDir: dir, fileName: "2026.parquet", source, stats });
    assert.equal(asText(buf), "SNAP");
    assert.equal(calls.fingerprint, 0);
    assert.equal(calls.download, 0);
    assert.deepEqual(stats, { hits: 1, hitBytes: 4, downloads: 0, downloadBytes: 0 });
    await assert.rejects(() => readThroughDiskCache({ cacheDir: dir, fileName: "2025.parquet", source, stats }), /고정 스냅샷에 2025.parquet이 없습니다/);
    assert.equal(calls.download, 0);
  } finally {
    if (prev === undefined) delete process.env.PARQUET_CACHE_FROZEN;
    else process.env.PARQUET_CACHE_FROZEN = prev;
  }
});
