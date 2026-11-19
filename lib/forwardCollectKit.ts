/**
 * [연구용 — 병합 금지] 앞으로 쌓이는 데이터 수집(소진율·분봉)과 가정 검증 프로브가 같이 쓰는 도구: KST 시각·호출 금지 시간대·Storage 입출력·KIS 호출(순차, rate limit 재시도, 최소 간격).
 * 키 값·응답 본문은 출력하지 않는다. 공시(DART) 사용 없음.
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { kisGetForResearch, getKisCallStats } from "@/lib/kis";
import { INVESTOR_FLOW_STOCK_STORE_BUCKET } from "@/lib/investorFlowConfig";
import { FWD_BLOCK_WINDOWS_UTC_MIN, FWD_RL_WAITS_MS, FWD_RL_WINDOW_MS, FWD_RL_WINDOW_MAX, FWD_CONSEC_ERROR_STOP, FWD_ERROR_RETRY_MS, FWD_MIN_GAP_MS } from "@/lib/forwardDataConfig";

export type Rec = Record<string, unknown>;
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
export const kst = (d = new Date()): string => new Date(d.getTime() + 9 * 3600e3).toISOString().slice(11, 19);
export const kstDate = (d = new Date()): string => new Date(d.getTime() + 9 * 3600e3).toISOString().slice(0, 10);
export const mib = (b: number): string => (b / 1048576).toFixed(2);
export const num = (v: unknown): number | null => { const s = String(v ?? "").trim(); if (s === "") return null; const n = Number(s); return Number.isFinite(n) ? n : null; };
export const iso8 = (d: string): string => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
export const addDays = (d: string, n: number): string => new Date(Date.parse(d) + n * 86_400_000).toISOString().slice(0, 10);

export function blockedNow(now = new Date()): boolean {
  const m = now.getUTCHours() * 60 + now.getUTCMinutes();
  return FWD_BLOCK_WINDOWS_UTC_MIN.some(([a, b]) => m >= a && m < b);
}
/** 지금이 금지 시간대면 끝날 때까지 남은 분(아니면 0). */
export function blockedMinutesLeft(now = new Date()): number {
  const m = now.getUTCHours() * 60 + now.getUTCMinutes();
  for (const [a, b] of FWD_BLOCK_WINDOWS_UTC_MIN) if (m >= a && m < b) return b - m;
  return 0;
}

// ---------------- Storage ----------------
export const io = { readBytes: 0, writeBytes: 0, reads: 0, writes: 0 };
const bucket = (): ReturnType<typeof supabaseAdmin.storage.from> => supabaseAdmin.storage.from(INVESTOR_FLOW_STOCK_STORE_BUCKET);
export async function download(p: string): Promise<ArrayBuffer | null> {
  const { data, error } = await bucket().download(p);
  if (error) { if (/not found|404|Object not found/i.test(error.message)) return null; throw new Error(`Storage 다운로드 실패 ${p}: ${error.message}`); }
  const buf = await data.arrayBuffer();
  io.readBytes += buf.byteLength; io.reads++;
  return buf;
}
export async function upload(p: string, body: ArrayBuffer | Uint8Array): Promise<void> {
  let lastMsg = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    const { error } = await bucket().upload(p, body, { contentType: "application/octet-stream", upsert: true });
    if (!error) { io.writeBytes += body.byteLength; io.writes++; return; }
    lastMsg = error.message;
    console.log(`  [Storage 업로드 재시도 ${attempt + 1}/4] ${p}: ${lastMsg || "<none>"}`);
    await sleep(3_000 * 2 ** attempt);
  }
  throw new Error(`Storage 업로드 실패 ${p}: ${lastMsg}`);
}
async function walk(b: string, prefix: string, acc: { bytes: number }): Promise<void> {
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabaseAdmin.storage.from(b).list(prefix, { limit: 1000, offset });
    if (error) throw new Error(`${b}/${prefix} 목록 실패: ${error.message}`);
    for (const e of data ?? []) { if (e.id === null) await walk(b, prefix ? `${prefix}/${e.name}` : e.name, acc); else acc.bytes += Number((e.metadata as { size?: number } | null)?.size ?? 0); }
    if (!data || data.length < 1000) break;
  }
}
export async function storageTotal(): Promise<number> {
  const { data, error } = await supabaseAdmin.storage.listBuckets();
  if (error) throw new Error(`버킷 목록 실패: ${error.message}`);
  const acc = { bytes: 0 };
  for (const b of data ?? []) await walk(b.name, "", acc);
  return acc.bytes;
}

// ---------------- KIS 호출 ----------------
export interface KisRun { req: number; errors: number; consec: number; rlEvents: number; rlTimes: number[]; rlRetries: number; rlWaitMs: number; stop: string | null; lastCallAt: number; latenciesMs: number[] }
export const newKisRun = (): KisRun => ({ req: 0, errors: 0, consec: 0, rlEvents: 0, rlTimes: [], rlRetries: 0, rlWaitMs: 0, stop: null, lastCallAt: 0, latenciesMs: [] });
const isRateLimitMsg = (msg: string): boolean => /EGW00201|rate\s*limit|too\s*many|초당|429/i.test(msg);

/** 금지 시간대 처리: 남은 금지 시간이 30분을 넘으면 기다리지 않고 멈춘다(run.stop, 다시 실행하면 이어받는다). 30분 이하면 30초마다 재확인하며 기다린다(회차 상한을 넘으면 그냥 반환). */
export async function waitIfBlocked(t0: number, maxMs: number, run?: KisRun): Promise<void> {
  for (;;) {
    const m = blockedMinutesLeft();
    if (m <= 0) return;
    if (Date.now() - t0 >= maxMs) return;
    if (m > 30 && run) { run.stop = `호출 금지 시간대(남은 ${m}분) — 끝난 뒤 다시 실행`; return; }
    console.log(`  [대기] KST ${kst()} — 호출 금지 시간대, 30초 후 재확인`);
    await sleep(30_000);
  }
}

/**
 * 순차 호출 하나. 성공하면 응답 본문, 실패하면 null(run.stop에 사유가 있으면 멈춘다). rate limit은 5/15/60초 재시도, 10분 안 N회면 중단, 연속 오류 N건이면 중단.
 * 호출 사이 최소 간격(FWD_MIN_GAP_MS)을 둔다.
 */
export async function callKis(run: KisRun, t0: number, maxMs: number, label: string, path: string, tr: string, params: Record<string, string>, extraHeaders?: Record<string, string>): Promise<Rec | null> {
  for (let rl = 0; ; rl++) {
    await waitIfBlocked(t0, maxMs, run);
    if (run.stop) return null;
    if (Date.now() - t0 >= maxMs) { run.stop = "회차 시간 상한"; return null; }
    const gap = FWD_MIN_GAP_MS - (Date.now() - run.lastCallAt);
    if (gap > 0) await sleep(gap);
    const r0 = getKisCallStats().total, c0 = Date.now();
    try {
      const body = await kisGetForResearch(path, tr, params, 0, extraHeaders);
      run.lastCallAt = Date.now(); run.latenciesMs.push(run.lastCallAt - c0);
      run.consec = 0; run.req += getKisCallStats().total - r0;
      return body as Rec;
    } catch (e) {
      run.lastCallAt = Date.now(); run.latenciesMs.push(run.lastCallAt - c0);
      run.req += getKisCallStats().total - r0;
      const msg = e instanceof Error ? e.message.slice(0, 200) : String(e);
      if (!/time\s*limit/i.test(msg) && isRateLimitMsg(msg)) {
        const now = Date.now(); run.rlEvents++; run.rlTimes.push(now);
        while (run.rlTimes.length && now - run.rlTimes[0] > FWD_RL_WINDOW_MS) run.rlTimes.shift();
        console.log(`  [rate limit KST ${kst()}] ${label}: ${msg} (이번 요청 ${rl + 1}번째 실패, 최근 10분 ${run.rlTimes.length}회)`);
        if (run.rlTimes.length >= FWD_RL_WINDOW_MAX) { run.stop = `rate limit 10분 안에 ${run.rlTimes.length}회`; return null; }
        if (rl >= FWD_RL_WAITS_MS.length) { run.stop = `rate limit ${FWD_RL_WAITS_MS.length}회 연속 재시도 실패`; return null; }
        const w = FWD_RL_WAITS_MS[rl]; run.rlRetries++; run.rlWaitMs += w;
        await sleep(w);
        continue;
      }
      run.errors++; run.consec++;
      console.log(`  [오류 KST ${kst()}] ${label}: ${msg} (연속 ${run.consec})`);
      if (/time\s*limit/i.test(msg)) run.stop = "TIME LIMIT 응답";
      else if (run.consec >= FWD_CONSEC_ERROR_STOP) run.stop = `연속 오류 ${FWD_CONSEC_ERROR_STOP}건`;
      if (!run.stop) await sleep(FWD_ERROR_RETRY_MS);
      return null;
    }
  }
}

/** 응답 본문에서 행 배열을 고른다: 우선 지정 키들, 없으면 첫 배열. */
export function rowsOf(body: Rec | null, keys: string[]): Rec[] {
  if (!body) return [];
  for (const k of keys) { const v = body[k]; if (Array.isArray(v)) return v as Rec[]; }
  for (const v of Object.values(body)) if (Array.isArray(v)) return v as Rec[];
  return [];
}
