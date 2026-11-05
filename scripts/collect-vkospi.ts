/**
 * [임시 연구 — 병합 금지] VKOSPI(코스피 200 변동성지수) 일별 종가 수집. 사전등록: docs/research/vkospi-scan-prereg.md.
 * KRX Open API idx/drvprod_dd_trd를 거래일별 1건씩 호출해 지수명이 정확히 VK_IDX_NAME인 행 한 개만 남긴다. 키: KRX_API_KEY(값 출력 금지).
 * 모드(VKOSPI_MODE): pilot = 연도별 대표 날짜 17개만 부르고 키 이름·행 수만 출력(저장 없음), collect = 이어받기 수집(Actions 캐시 .vkospi-resume) 후 정리본 저장.
 * KST 14:00~15:40에는 실행하지 않는다. 연구 DB 쓰기 0(KOSPI 거래일 읽기만), Storage 쓰기만(소량), Storage 읽기 0. 학습 구간(~2016-12-31) 밖 값은 출력하지 않는다.
 */
import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { parquetWriteBuffer } from "hyparquet-writer";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getIndexPriceSeries } from "@/lib/betaPriceHistoryStorage";
import { INVESTOR_FLOW_STOCK_STORE_BUCKET } from "@/lib/investorFlowConfig";
import { SC_COLLECT_BLOCK_UTC_FROM_MIN, SC_COLLECT_BLOCK_UTC_TO_MIN, SC_COLLECT_RL_WAITS_MS } from "@/lib/shortCreditCollectConfig";
import { VK_ENDPOINT, VK_BASE_URL, VK_IDX_NAME, VK_FROM, VK_TO, VK_GAP_MS, VK_REQUEST_CAP, VK_RUN_MAX_MS, VK_LOG_EVERY_REQ, VK_CONSEC_ERROR_STOP, VK_PREFIX, VK_CACHE_DIR, VK_PROGRESS_FILE, VK_WRITE_BUDGET_BYTES, VK_LEARN_END, VK_PREREG_DOC } from "@/lib/vkospiScanConfig";

const T0 = Date.now();
const MODE = (process.env.VKOSPI_MODE ?? "pilot").trim();
const RESUME_DIR = ".vkospi-resume";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const num = (s: unknown): number | null => { const t = String(s ?? "").replace(/,/g, "").trim(); const n = Number(t); return t !== "" && Number.isFinite(n) ? n : null; };
type Status = "ok" | "empty" | "noname" | "dup";
interface Rec { d: string; cls: string; nm: string; close: number | null; chg: number | null; rt: number | null; open: number | null; high: number | null; low: number | null }
interface State { status: Record<string, Status>; rows: Record<string, Rec>; requests: number; runs: { startedAt: string; requests: number; stop: string }[] }
const state: State = { status: {}, rows: {}, requests: 0, runs: [] };
const run = { req: 0, consec: 0, rl: 0, errors: 0, stop: "" };

async function krx(basDd: string, key: string): Promise<{ http: number; json: Record<string, unknown> | null }> {
  const res = await fetch(`${VK_BASE_URL}/${VK_ENDPOINT}?basDd=${basDd}`, { headers: { AUTH_KEY: key } });
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { json = null; }
  return { http: res.status, json };
}
const blockNow = (): boolean => { const n = new Date(), m = n.getUTCHours() * 60 + n.getUTCMinutes(); return m >= SC_COLLECT_BLOCK_UTC_FROM_MIN && m < SC_COLLECT_BLOCK_UTC_TO_MIN; };

/** 한 날짜를 부른다. 성공하면 상태를 기록하고 true, 중단 사유가 생기면 false. */
async function fetchDay(date: string, key: string, pilot: boolean): Promise<boolean> {
  for (let rl = 0; ; rl++) {
    if (blockNow()) { run.stop = "KST 14:00~15:40 호출 금지 시간대"; return false; }
    if (run.req >= VK_REQUEST_CAP) { run.stop = `요청 상한 ${VK_REQUEST_CAP}`; return false; }
    if (Date.now() - T0 > VK_RUN_MAX_MS) { run.stop = "회차 최대 시간"; return false; }
    await sleep(VK_GAP_MS);
    run.req++; state.requests++;
    let r: { http: number; json: Record<string, unknown> | null };
    try { r = await krx(date.replace(/-/g, ""), key); } catch { r = { http: 0, json: null }; }
    if (r.http === 401 || r.http === 403) { run.stop = `HTTP ${r.http}(권한)`; return false; }
    const block = r.json ? (r.json.OutBlock_1 as Record<string, unknown>[] | undefined) : undefined;
    if (r.http === 200 && Array.isArray(block)) {
      const hit = block.filter((x) => String(x.IDX_NM ?? "").trim() === VK_IDX_NAME);
      if (pilot) {
        console.log(`  ${date}: HTTP 200, 응답 행 ${block.length}개, 지수명 일치 행 ${hit.length}개${hit[0] ? `, 일치 행 키 ${Object.keys(hit[0]).join(",")}` : ""}`);
        return true;
      }
      run.consec = 0;
      if (block.length === 0) { state.status[date] = "empty"; return true; }
      if (hit.length === 0) { state.status[date] = "noname"; return true; }
      if (hit.length > 1) { state.status[date] = "dup"; return true; }
      const x = hit[0];
      if (num(x.CLSPRC_IDX) === null) { run.stop = `${date}: 일치 행에 종가(CLSPRC_IDX) 값 없음`; return false; }
      state.status[date] = "ok";
      state.rows[date] = { d: date, cls: String(x.IDX_CLSS ?? ""), nm: VK_IDX_NAME, close: num(x.CLSPRC_IDX), chg: num(x.CMPPREVDD_IDX), rt: num(x.FLUC_RT), open: num(x.OPNPRC_IDX), high: num(x.HGPRC_IDX), low: num(x.LWPRC_IDX) };
      return true;
    }
    // 오류·한도: 대기 후 재시도
    run.errors++; run.consec++;
    console.log(`  [오류 ${date}] HTTP ${r.http}${r.json ? ` respCode ${String(r.json.respCode ?? "-")}` : " 비 JSON"} (재시도 ${rl + 1}/${SC_COLLECT_RL_WAITS_MS.length})`);
    if (run.consec >= VK_CONSEC_ERROR_STOP) { run.stop = `연속 오류 ${run.consec}회`; return false; }
    if (rl >= SC_COLLECT_RL_WAITS_MS.length) { run.stop = `${date}: 재시도 ${SC_COLLECT_RL_WAITS_MS.length}회 실패`; return false; }
    run.rl++;
    await sleep(SC_COLLECT_RL_WAITS_MS[rl]);
  }
}

async function loadResume(): Promise<void> {
  try { const s = JSON.parse(await fsp.readFile(path.join(RESUME_DIR, "state.json"), "utf8")) as State; Object.assign(state, s); console.log(`이어받기: 완료 날짜 ${Object.keys(state.status).length}개, 누적 요청 ${state.requests}`); }
  catch { console.log("이어받기 파일 없음 — 처음부터"); }
}
async function saveResume(): Promise<void> { await fsp.mkdir(RESUME_DIR, { recursive: true }); await fsp.writeFile(path.join(RESUME_DIR, "state.json"), JSON.stringify(state)); }

async function calendar(): Promise<string[]> {
  const kospi = await getIndexPriceSeries("KOSPI", VK_FROM, VK_TO);
  const days = kospi.map((p) => p.tradeDate).filter((d) => d >= VK_FROM && d <= VK_TO);
  console.log(`KOSPI 거래일(DB 읽기 ${kospi.length}행) ${days.length}일`);
  const set = new Set(days), last = days[days.length - 1];
  const extra: string[] = [];
  for (let t = Date.parse(last) + 86_400_000; t <= Date.parse(VK_TO); t += 86_400_000) { const dt = new Date(t), w = dt.getUTCDay(); if (w >= 1 && w <= 5) { const d = dt.toISOString().slice(0, 10); if (!set.has(d)) extra.push(d); } }
  if (extra.length) console.log(`DB 마지막 거래일 ${last} 뒤 평일 ${extra.length}일 추가(휴장일은 빈 응답)`);
  return [...days, ...extra];
}

async function main(): Promise<void> {
  const kst = new Date(Date.now() + 9 * 3600_000);
  console.log(`VKOSPI 수집 시작(${MODE}): ${new Date().toISOString()} (KST ${String(kst.getUTCHours()).padStart(2, "0")}:${String(kst.getUTCMinutes()).padStart(2, "0")}) | 사전등록 ${VK_PREREG_DOC}`);
  if (blockNow()) throw new Error("KST 14:00~15:40에는 KRX를 호출하지 않는다 — 실행 거부");
  const key = process.env.KRX_API_KEY;
  if (!key) throw new Error("KRX_API_KEY 없음");
  if (MODE === "pilot") {
    for (const d of ["2011-01-03", "2011-08-09", "2012-06-29", "2013-06-28", "2014-06-30", "2015-06-30", "2016-06-30", "2016-12-27", "2016-12-28", "2016-12-29", "2016-12-30", "2017-01-02", "2017-06-30", "2019-06-28", "2021-06-30", "2023-06-30", "2026-11-04"]) { if (!(await fetchDay(d, key, true))) { console.log(`중단: ${run.stop}`); break; } }
    console.log(`\n파일럿 종료: KRX 호출 ${run.req}회, 오류 ${run.errors}회 | 저장 0 | DB 쓰기 0 | DART 호출 0`);
    return;
  }
  if (MODE !== "collect") throw new Error(`알 수 없는 모드 ${MODE}`);
  await loadResume();
  const days = await calendar();
  let todo = days.filter((d) => !state.status[d]);
  console.log(`수집 대상 ${days.length}일 중 남은 날짜 ${todo.length}일 | 요청 상한 ${VK_REQUEST_CAP}, 간격 ${VK_GAP_MS}ms`);
  let lastLog = 0;
  for (const d of todo) {
    if (!(await fetchDay(d, key, false))) break;
    if (run.req - lastLog >= VK_LOG_EVERY_REQ) { lastLog = run.req; await saveResume(); console.log(`진행: 요청 ${run.req}, 마지막 ${d <= VK_LEARN_END ? d : "(학습 구간 밖)"}, 완료 ${Object.keys(state.status).length}/${days.length}, ${((Date.now() - T0) / 60000).toFixed(1)}분`); }
  }
  state.runs.push({ startedAt: new Date(T0).toISOString(), requests: run.req, stop: run.stop || "완료" });
  await saveResume();
  todo = days.filter((d) => !state.status[d]);
  if (todo.length) { console.log(`\n중단: ${run.stop} | 남은 날짜 ${todo.length}일 — 이어받기 파일 저장(.vkospi-resume), 정리본은 만들지 않음`); return; }

  // ---- 정리본: 날짜순 행, 연도별 Parquet, 매니페스트 ----
  const rows = Object.values(state.rows).sort((a, b) => (a.d < b.d ? -1 : 1));
  const count = (s: Status): number => Object.values(state.status).filter((x) => x === s).length;
  const learnDays = days.filter((d) => d <= VK_LEARN_END);
  const learnMissing = learnDays.filter((d) => state.status[d] !== "ok");
  const learnRows = rows.filter((r) => r.d <= VK_LEARN_END);
  console.log(`\n=== 수집 결과 ===\n호출 ${state.requests}건(이번 회차 ${run.req}건, 오류 ${run.errors}건, 재시도 대기 ${run.rl}회) | 날짜 ${days.length}일: 값 있음 ${count("ok")}, 빈 응답 ${count("empty")}, 지수명 없음 ${count("noname")}, 지수명 중복 ${count("dup")}`);
  const byY = new Map<string, Rec[]>();
  for (const r of rows) { const y = r.d.slice(0, 4), a = byY.get(y); if (a) a.push(r); else byY.set(y, [r]); }
  console.log(`연도별 행 수: ${[...byY].map(([y, l]) => `${y} ${l.length}`).join(", ")}`);
  console.log(`학습 구간(~${VK_LEARN_END}) KOSPI 거래일 ${learnDays.length}일 중 값 없는 날 ${learnMissing.length}일(${(learnMissing.length / Math.max(learnDays.length, 1) * 100).toFixed(2)}%)${learnMissing.length ? `: ${learnMissing.slice(0, 20).join(", ")}${learnMissing.length > 20 ? " …" : ""}` : ""}`);
  if (learnRows.length) { const cl = learnRows.map((r) => r.close as number); console.log(`학습 구간 종가 범위(sanity) ${Math.min(...cl).toFixed(2)} ~ ${Math.max(...cl).toFixed(2)}, 0 이하 ${cl.filter((x) => !(x > 0)).length}건`); }
  const nonLearn = rows.filter((r) => r.d > VK_LEARN_END).length;
  console.log(`학습 구간 밖 행 ${nonLearn}개는 값을 출력하지 않음(행 수만)`);

  const cols = [{ name: "trade_date", type: "STRING" as const }, { name: "idx_clss", type: "STRING" as const }, { name: "idx_nm", type: "STRING" as const }, { name: "close", type: "DOUBLE" as const }, { name: "chg", type: "DOUBLE" as const }, { name: "fluc_rt", type: "DOUBLE" as const }, { name: "open", type: "DOUBLE" as const }, { name: "high", type: "DOUBLE" as const }, { name: "low", type: "DOUBLE" as const }];
  const enc = (l: Rec[]): ArrayBuffer => parquetWriteBuffer({ columnData: cols.map((c) => {
    const get = (r: Rec): string | number | null => c.name === "trade_date" ? r.d : c.name === "idx_clss" ? r.cls : c.name === "idx_nm" ? r.nm : c.name === "close" ? r.close : c.name === "chg" ? r.chg : c.name === "fluc_rt" ? r.rt : c.name === "open" ? r.open : c.name === "high" ? r.high : r.low;
    return c.type === "STRING" ? { name: c.name, data: l.map((r) => get(r) as string), type: "STRING" as const } : { name: c.name, data: l.map((r) => get(r) as number | null), type: "DOUBLE" as const, nullable: true };
  }) });
  await fsp.mkdir(VK_CACHE_DIR, { recursive: true });
  const files: { name: string; bytes: number; sha256: string; rows: number }[] = [];
  let written = 0;
  const bucket = supabaseAdmin.storage.from(INVESTOR_FLOW_STOCK_STORE_BUCKET);
  for (const [y, l] of [...byY].sort()) {
    const buf = Buffer.from(enc(l)), name = `${y}.parquet`;
    await fsp.writeFile(path.join(VK_CACHE_DIR, name), buf);
    files.push({ name, bytes: buf.byteLength, sha256: createHash("sha256").update(buf).digest("hex"), rows: l.length });
    let err = "";
    for (let a = 0; a < 4; a++) { const { error } = await bucket.upload(`${VK_PREFIX}/${name}`, buf, { contentType: "application/octet-stream", upsert: true }); if (!error) { err = ""; written += buf.byteLength; break; } err = error.message; await sleep(3_000 * 2 ** a); }
    if (err) throw new Error(`Storage 업로드 실패 ${name}: ${err}`);
  }
  const status = Object.fromEntries(days.map((d) => [d, state.status[d]]));
  await fsp.writeFile(path.join(VK_CACHE_DIR, "calendar.json"), JSON.stringify(status));
  await bucket.upload(`${VK_PREFIX}/${VK_PROGRESS_FILE}`, new TextEncoder().encode(JSON.stringify({ requests: state.requests, status: count("ok") })), { contentType: "application/octet-stream", upsert: true });
  const manifest = { createdAt: new Date().toISOString(), idxName: VK_IDX_NAME, from: VK_FROM, to: VK_TO, files, days: days.length, ok: count("ok") };
  await fsp.writeFile(path.join(VK_CACHE_DIR, "manifest.json"), JSON.stringify(manifest));
  console.log(`정리본: 파일 ${files.length}개 ${(files.reduce((a, f) => a + f.bytes, 0) / 1024).toFixed(1)} KiB | Storage 쓰기 ${(written / 1024).toFixed(1)} KiB(예산 ${(VK_WRITE_BUDGET_BYTES / 1024).toFixed(0)} KiB)${written > VK_WRITE_BUDGET_BYTES ? " — 경고: 예산 초과" : ""} | Storage 읽기 0 | 연구 DB 쓰기 0 | DART 호출 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });
