/**
 * [임시 연구 — 병합 금지] 매크로 일별 원본 수집(WTI·브렌트·원/달러·나스닥·국고채 3·10년, 2010-01~현재). 근거: docs/research/data-feasibility-3.md, 사용자 지정 2026-11-14.
 * FRED(WTI·브렌트·DEXKOUS·나스닥)와 ECOS(원/달러 매매기준율·국고채 3년·10년)에서 원본 일별 값만 받아 긴 형식 Parquet 한 개(research/macro_daily/macro_daily.parquet)와
 * 매니페스트(SHA-256·시리즈별 행 수·기간)로 Storage에 저장한다. 신호·수익률·정렬(한국 거래일 맞추기)은 계산하지 않는다(다음 사전등록에서 정함). 공시(DART) 사용 없음, 연구 DB 쓰기 0, Storage 쓰기만(소량).
 * 키(FRED_API_KEY, ECOS_API_KEY) 값과 키가 들어간 요청 주소는 출력하지 않는다. KIS·KRX 호출 없음. 아티팩트로 올리지 않는다(공개 저장소 규칙).
 */
import { createHash } from "node:crypto";
import { parquetWriteBuffer } from "hyparquet-writer";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { INVESTOR_FLOW_STOCK_STORE_BUCKET } from "@/lib/investorFlowConfig";
import { MACRO_FROM, MACRO_PARQUET, MACRO_MANIFEST, MACRO_WRITE_BUDGET_BYTES, MACRO_STORAGE_CAP_BYTES, MACRO_ECOS_PAGE, MACRO_GAP_MS, MACRO_SERIES, type MacroSeries } from "@/lib/macroDailyConfig";

const T0 = Date.now();
const MiB = 1048576;
const mib = (b: number): string => (b / MiB).toFixed(2);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const sha = (b: Uint8Array | ArrayBuffer): string => createHash("sha256").update(b instanceof ArrayBuffer ? new Uint8Array(b) : b).digest("hex");
interface Obs { series_id: string; obs_date: string; value: number | null; source: string }
const calls = { fred: 0, ecos: 0 };

const bucket = (): ReturnType<typeof supabaseAdmin.storage.from> => supabaseAdmin.storage.from(INVESTOR_FLOW_STOCK_STORE_BUCKET);
async function walk(b: string, prefix: string, acc: { bytes: number }): Promise<void> {
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabaseAdmin.storage.from(b).list(prefix, { limit: 1000, offset });
    if (error) throw new Error(`${b}/${prefix} 목록 실패: ${error.message}`);
    for (const e of data ?? []) { if (e.id === null) await walk(b, prefix ? `${prefix}/${e.name}` : e.name, acc); else acc.bytes += Number((e.metadata as { size?: number } | null)?.size ?? 0); }
    if (!data || data.length < 1000) break;
  }
}
async function storageTotal(): Promise<number> {
  const { data, error } = await supabaseAdmin.storage.listBuckets();
  if (error) throw new Error(`버킷 목록 실패: ${error.message}`);
  const acc = { bytes: 0 };
  for (const b of data ?? []) await walk(b.name, "", acc);
  return acc.bytes;
}
async function upload(p: string, body: ArrayBuffer | Uint8Array, type: string): Promise<void> {
  let lastMsg = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    const { error } = await bucket().upload(p, body, { contentType: type, upsert: true });
    if (!error) return;
    lastMsg = error.message;
    console.log(`  [Storage 업로드 재시도 ${attempt + 1}/4] ${p}: ${lastMsg || "<none>"}`);
    await sleep(3_000 * 2 ** attempt);
  }
  throw new Error(`Storage 업로드 실패 ${p}: ${lastMsg}`);
}

const today = new Date().toISOString().slice(0, 10);
const redact = (s: string, keys: (string | undefined)[]): string => keys.reduce<string>((a, k) => (k ? a.split(k).join("***") : a), s);

async function getJson(url: string, keys: (string | undefined)[]): Promise<Record<string, unknown>> {
  let last = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url);
      const text = await res.text();
      if (res.status === 200) { try { return JSON.parse(text) as Record<string, unknown>; } catch { last = "비 JSON 응답"; } } else last = `HTTP ${res.status} ${redact(text.slice(0, 160), keys)}`;
    } catch (e) { last = redact(e instanceof Error ? e.message : String(e), keys); }
    await sleep(2_000 * 2 ** attempt);
  }
  throw new Error(`요청 실패(주소·키 비공개): ${last}`);
}

async function fetchFred(s: MacroSeries, key: string): Promise<Obs[]> {
  calls.fred++;
  const q = new URLSearchParams({ series_id: s.code, observation_start: MACRO_FROM, observation_end: today, file_type: "json", api_key: key });
  const body = await getJson(`https://api.stlouisfed.org/fred/series/observations?${q.toString()}`, [key]);
  const o = (body.observations as { date: string; value: string }[] | undefined) ?? [];
  return o.map((r) => ({ series_id: s.id, obs_date: r.date, value: r.value === "." || r.value === "" ? null : Number(r.value), source: "fred:" + s.code }));
}
async function fetchEcos(s: MacroSeries, key: string): Promise<Obs[]> {
  const out: Obs[] = [];
  const from = MACRO_FROM.replace(/-/g, ""), to = today.replace(/-/g, "");
  for (let start = 1; ; start += MACRO_ECOS_PAGE) {
    calls.ecos++;
    const end = start + MACRO_ECOS_PAGE - 1;
    const body = await getJson(`https://ecos.bok.or.kr/api/StatisticSearch/${key}/json/kr/${start}/${end}/${s.code}/${s.ecosCycle}/${from}/${to}/${s.ecosItem}`, [key]);
    const ss = body.StatisticSearch as { list_total_count?: number; row?: { TIME: string; DATA_VALUE: string }[] } | undefined;
    if (!ss) throw new Error(`ECOS 응답 형식 이상(${s.id}): ${redact(JSON.stringify(body).slice(0, 160), [key])}`);
    for (const r of ss.row ?? []) { const t = String(r.TIME); const v = String(r.DATA_VALUE).trim(); out.push({ series_id: s.id, obs_date: `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`, value: v === "" ? null : Number(v), source: `ecos:${s.code}/${s.ecosItem}` }); }
    if (!ss.list_total_count || end >= ss.list_total_count) break;
    await sleep(MACRO_GAP_MS);
  }
  return out;
}

async function main(): Promise<void> {
  console.log(`매크로 일별 원본 수집 시작: ${new Date().toISOString()} | 기간 ${MACRO_FROM}~${today} | 시리즈 ${MACRO_SERIES.length}개 | 신호·수익률·정렬 계산 없음`);
  const fredKey = process.env.FRED_API_KEY, ecosKey = process.env.ECOS_API_KEY;
  if (!fredKey || !ecosKey) throw new Error("FRED_API_KEY·ECOS_API_KEY가 필요하다(값은 출력하지 않는다)");
  const before = await storageTotal();
  console.log(`Storage 총량(시작): ${mib(before)} MiB / 상한 ${mib(MACRO_STORAGE_CAP_BYTES)} MiB`);
  if (before > MACRO_STORAGE_CAP_BYTES - 5 * MiB) throw new Error("Storage 총량이 상한에 가까워 중단한다");
  const all: Obs[] = [];
  const meta: Record<string, unknown>[] = [];
  for (const s of MACRO_SERIES) {
    const rows = s.source === "fred" ? await fetchFred(s, fredKey) : await fetchEcos(s, ecosKey);
    await sleep(MACRO_GAP_MS);
    const keyset = new Set<string>();
    let dup = 0, nulls = 0, unsorted = 0, prev = "";
    for (const r of rows) { const k = r.obs_date; if (keyset.has(k)) dup++; keyset.add(k); if (r.value === null) nulls++; if (prev && k < prev) unsorted++; prev = k; }
    if (rows.length === 0) throw new Error(`${s.id} 응답이 비었다 — 중단하고 보고한다`);
    if (dup > 0) throw new Error(`${s.id} 날짜 중복 ${dup}건 — 중단하고 보고한다`);
    const chk = rows.find((r) => r.obs_date === s.check.date);
    console.log(`  ${s.id.padEnd(12)} ${s.source}:${s.code}${s.ecosItem ? "/" + s.ecosItem : ""} | 행 ${rows.length} | 기간 ${rows[0].obs_date}~${rows[rows.length - 1].obs_date} | 값 없음 ${nulls}(${((nulls / rows.length) * 100).toFixed(2)}%) | 날짜 역순 ${unsorted}건 | ${s.check.date} 값 ${chk ? String(chk.value) : "없음"}${s.check.value > 0 ? ` (데이터 점검 3 값 ${s.check.value}${chk && chk.value === s.check.value ? " 일치" : " 불일치 — 경고"})` : ""}`);
    meta.push({ id: s.id, source: s.source, code: s.code, item: s.ecosItem ?? null, label: s.label, unit: s.unit, rows: rows.length, nulls, first: rows[0].obs_date, last: rows[rows.length - 1].obs_date });
    all.push(...rows);
  }
  all.sort((a, b) => (a.series_id < b.series_id ? -1 : a.series_id > b.series_id ? 1 : a.obs_date < b.obs_date ? -1 : 1));
  const body = parquetWriteBuffer({ columnData: [
    { name: "series_id", data: all.map((r) => r.series_id), type: "STRING" as const },
    { name: "obs_date", data: all.map((r) => r.obs_date), type: "STRING" as const },
    { name: "value", data: all.map((r) => r.value), type: "DOUBLE" as const, nullable: true },
    { name: "source", data: all.map((r) => r.source), type: "STRING" as const },
  ] });
  const manifest = { builtAt: new Date().toISOString(), from: MACRO_FROM, to: today, rows: all.length, bytes: body.byteLength, sha256: sha(body), series: meta, note: "원본 일별 값만 저장(신호·수익률·한국 거래일 정렬 없음). FRED 결측('.')은 null." };
  const mbody = new TextEncoder().encode(JSON.stringify(manifest, null, 1));
  await upload(MACRO_PARQUET, body, "application/octet-stream");
  await upload(MACRO_MANIFEST, mbody, "application/json");
  const written = body.byteLength + mbody.byteLength;
  const after = await storageTotal();
  console.log(`\n저장: ${MACRO_PARQUET} ${all.length}행 ${(body.byteLength / 1024).toFixed(1)} KiB SHA-256 ${manifest.sha256.slice(0, 16)}… | ${MACRO_MANIFEST}`);
  console.log(`Storage 총량: 시작 ${mib(before)} → 끝 ${mib(after)} MiB (+${mib(after - before)} MiB, 업로드 ${mib(written)} MiB, 쓰기 예산 ${mib(MACRO_WRITE_BUDGET_BYTES)} MiB, 상한 ${mib(MACRO_STORAGE_CAP_BYTES)} MiB 안 ${after < MACRO_STORAGE_CAP_BYTES ? "예" : "아니오"})`);
  if (written > MACRO_WRITE_BUDGET_BYTES) console.log("경고: 쓰기 예산 초과");
  console.log(`외부 요청: FRED ${calls.fred}회, ECOS ${calls.ecos}회, KIS·KRX 0회 | Storage 읽기 0(총량 목록 조회만) | DB 쓰기 0 | DART 호출 0 | 소요 ${((Date.now() - T0) / 1000).toFixed(0)}초`);
}

main().catch((e) => { console.error(redact(e instanceof Error ? e.stack ?? e.message : String(e), [process.env.FRED_API_KEY, process.env.ECOS_API_KEY])); process.exit(1); });
