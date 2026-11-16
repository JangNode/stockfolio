/**
 * [연구용 — 병합 금지] 외국인 소진율(hts_frgn_ehrt) 일별 앞으로 쌓기: 대상 종목마다 inquire-daily-price(최근 30거래일, 날짜 지정 없음) 1회 → 새 거래일 행만 Storage research/forward/frgn_ehrt/ 에 한 사본으로 저장.
 * 승인: docs/research/forward-data-plan.md(사용자 2026-11-17: 현재 상장 372종목, 4주마다 수동, 마감 35일, 한 사본). 수집만 한다(분석·신호 확인 없음). 연구 데이터 표 DB 쓰기 0(KIS 토큰 행 갱신 제외), 공시(DART) 사용 없음, 아티팩트·캐시로 데이터를 올리지 않는다.
 * 이어받기: `_progress.json`(실행 번호 = FWD_RUN_ID, 기본 KST 오늘; 같은 번호면 완료 종목을 건너뛴다). 이어 붙이기: `manifest.json`의 종목별 마지막 거래일·최근 12거래일 값과 비교 — 새 날짜는 행 추가, 겹치는 날짜에서 값이 달라진 건 rev=1 행으로 추가, 겹침이 없으면 사이에 열린 거래일이 있는지 krx_trading_calendar로 확인해 공백(GAP)을 기록하고 채우지 않는다.
 * 호출 금지 시간대(14:00~15:40, 03:50~06:20 KST)에는 기다린다. 키 값·응답 본문은 출력하지 않는다.
 */
import { createHash } from "node:crypto";
import { parquetWriteBuffer } from "hyparquet-writer";
import { parquetReadObjects } from "hyparquet";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadAllStockSeriesFromParquet } from "@/lib/stockDailyPricesStorage";
import { INVESTOR_FLOW_TOP_N, INVESTOR_FLOW_ENDED_GRACE_DAYS } from "@/lib/investorFlowConfig";
import { FWD_FRGN_PREFIX, FWD_PROGRESS_FILE, FWD_MANIFEST_FILE, FWD_TARGETS_FILE, FWD_DAILY_PATH, FWD_DAILY_TR, FWD_DAILY_ROWS, FWD_RUN_MAX_MS, FWD_CHECKPOINT_MS, FWD_STORAGE_CAP_BYTES, FWD_STORAGE_HEADROOM_BYTES, FWD_FRGN_WRITE_BUDGET_BYTES, FWD_WRITE_GUARD_FACTOR, FWD_LOG_EVERY_REQ } from "@/lib/forwardDataConfig";
import { callKis, newKisRun, rowsOf, io, download, upload, storageTotal, kst, kstDate, mib, num, iso8, addDays, type Rec } from "@/lib/forwardCollectKit";

const T0 = Date.now();
const RUN_ID = (process.env.FWD_RUN_ID ?? "").trim() || kstDate();
const MS_DAY = 86_400_000;
const TAIL = 12;
type Row = { stock_code: string; trade_date: string; ehrt: number | null; ntby: number | null; rev: number };
interface StockProg { done: boolean; rows: number; revs: number; gap: string | null; empty: boolean }
interface Progress { runId: string; startedAt: string; stocks: Record<string, StockProg>; requests: number; errors: number }
interface ManStock { last_date: string; tail: [string, number | null][] }
interface Manifest { updatedAt: string; runs: { runId: string; file: string; rows: number; sha256: string; bytes: number }[]; stocks: Record<string, ManStock> }
const run = newKisRun();
const text = (b: ArrayBuffer): string => new TextDecoder().decode(b);
const sha = (b: ArrayBuffer | Uint8Array): string => createHash("sha256").update(b instanceof ArrayBuffer ? new Uint8Array(b) : b).digest("hex");

function encode(rows: Row[]): ArrayBuffer {
  const l = [...rows].sort((a, b) => (a.stock_code < b.stock_code ? -1 : a.stock_code > b.stock_code ? 1 : a.trade_date < b.trade_date ? -1 : a.trade_date > b.trade_date ? 1 : a.rev - b.rev));
  return parquetWriteBuffer({ columnData: [
    { name: "stock_code", data: l.map((r) => r.stock_code), type: "STRING" as const },
    { name: "trade_date", data: l.map((r) => r.trade_date), type: "STRING" as const },
    { name: "ehrt", data: l.map((r) => r.ehrt), type: "DOUBLE" as const, nullable: true },
    { name: "ntby", data: l.map((r) => r.ntby), type: "DOUBLE" as const, nullable: true },
    { name: "rev", data: l.map((r) => r.rev), type: "INT32" as const },
  ] });
}

/** 수집 대상: 월말 PIT 시총 상위 150 이력 420종목 중 현재 상장(고정 스냅샷 마지막 날 기준 상장폐지 아님). 처음 한 번만 만들고 targets.json에 저장한다. */
async function buildTargets(): Promise<{ codes: string[]; basis: string; total: number; delisted: number }> {
  const series = await loadAllStockSeriesFromParquet(2010, new Date().getUTCFullYear());
  const calSet = new Set<string>(); let lastDate = "";
  for (const rows of series.values()) for (const r of rows) { if (r.tradeDate >= "2010-01-01") calSet.add(r.tradeDate); if (r.tradeDate > lastDate) lastDate = r.tradeDate; }
  const cal = [...calSet].sort();
  const monthEnd = new Set<string>();
  for (let k = 0; k + 1 < cal.length; k++) if (cal[k].slice(0, 7) !== cal[k + 1].slice(0, 7)) monthEnd.add(cal[k]);
  const mcapAt = new Map<string, { code: string; mc: number }[]>(), lastRow = new Map<string, string>();
  for (const [code, rows] of series) for (const r of rows) {
    if (r.tradeDate < "2010-01-01") continue;
    if (monthEnd.has(r.tradeDate)) { const a = mcapAt.get(r.tradeDate) ?? []; a.push({ code, mc: r.marketCapEok }); mcapAt.set(r.tradeDate, a); }
    lastRow.set(code, r.tradeDate);
  }
  const everTop = new Set<string>();
  for (const [, arr] of mcapAt) { arr.sort((a, b) => b.mc - a.mc || (a.code < b.code ? -1 : 1)); for (const x of arr.slice(0, INVESTOR_FLOW_TOP_N)) everTop.add(x.code); }
  const endedBefore = new Date(Date.parse(lastDate) - INVESTOR_FLOW_ENDED_GRACE_DAYS * MS_DAY).toISOString().slice(0, 10);
  const pool = [...everTop].sort(), live = pool.filter((c) => (lastRow.get(c) ?? "9999") >= endedBefore);
  series.clear();
  return { codes: live, basis: `고정 스냅샷 마지막 날 ${lastDate}, 월말 PIT 시총 상위 ${INVESTOR_FLOW_TOP_N} 이력 ${pool.length}종목 중 상장폐지(마지막 행 < ${endedBefore}) ${pool.length - live.length}개 제외`, total: pool.length, delisted: pool.length - live.length };
}

async function openDays(from: string, to: string): Promise<string[]> {
  const out: string[] = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await supabaseAdmin.from("krx_trading_calendar").select("trade_date, is_open").gte("trade_date", from).lte("trade_date", to).order("trade_date").range(off, off + 999);
    if (error) throw new Error(`krx_trading_calendar 읽기 실패: ${error.message}`);
    for (const r of data ?? []) if (r.is_open) out.push(String(r.trade_date));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function main(): Promise<void> {
  console.log(`외국인 소진율 앞으로 쌓기 시작: ${new Date().toISOString()} (KST ${kst()}) | 실행 번호 ${RUN_ID} | 회차 상한 ${(FWD_RUN_MAX_MS / 3600e3).toFixed(2)}시간 | 저장 경로 ${FWD_FRGN_PREFIX}/ (한 사본)`);
  const storageStart = await storageTotal();
  console.log(`Storage 총량(시작): ${mib(storageStart)} MiB / 상한 ${mib(FWD_STORAGE_CAP_BYTES)} MiB (여유 ${mib(FWD_STORAGE_CAP_BYTES - storageStart)} MiB)`);
  if (storageStart > FWD_STORAGE_CAP_BYTES - FWD_STORAGE_HEADROOM_BYTES) throw new Error("Storage 총량이 상한에 가까워 시작하지 않는다 — 보고한다");

  // ---- 대상 ----
  let targets: { codes: string[]; basis: string; total: number; delisted: number };
  const tb = await download(`${FWD_FRGN_PREFIX}/${FWD_TARGETS_FILE}`);
  if (tb) { targets = JSON.parse(text(tb)); console.log(`대상(저장본): ${targets.codes.length}종목 — ${targets.basis}`); }
  else {
    targets = await buildTargets();
    await upload(`${FWD_FRGN_PREFIX}/${FWD_TARGETS_FILE}`, new TextEncoder().encode(JSON.stringify({ ...targets, builtAt: new Date().toISOString() })));
    console.log(`대상(새로 만듦): ${targets.codes.length}종목 — ${targets.basis}`);
  }
  const codes = targets.codes;

  // ---- 진행·매니페스트·이미 받은 행(같은 실행 번호의 이어받기) ----
  const pb = await download(`${FWD_FRGN_PREFIX}/${FWD_PROGRESS_FILE}`);
  let progress: Progress = { runId: RUN_ID, startedAt: new Date().toISOString(), stocks: {}, requests: 0, errors: 0 };
  const prev = pb ? (JSON.parse(text(pb)) as Progress) : null;
  if (prev && prev.runId === RUN_ID) { progress = prev; console.log(`이어받기: 실행 번호 ${RUN_ID}, 완료 ${Object.values(prev.stocks).filter((s) => s.done).length}/${codes.length}종목`); }
  const mb = await download(`${FWD_FRGN_PREFIX}/${FWD_MANIFEST_FILE}`);
  const manifest: Manifest = mb ? (JSON.parse(text(mb)) as Manifest) : { updatedAt: "", runs: [], stocks: {} };
  const runFile = `${FWD_FRGN_PREFIX}/${RUN_ID}.parquet`;
  const rows: Row[] = [];
  if (prev && prev.runId === RUN_ID) {
    const rb = await download(runFile);
    if (rb) for (const r of (await parquetReadObjects({ file: rb })) as Record<string, unknown>[]) rows.push({ stock_code: String(r.stock_code), trade_date: String(r.trade_date), ehrt: num(r.ehrt), ntby: num(r.ntby), rev: Number(r.rev) });
    console.log(`이어받기: 이번 실행 번호에서 이미 저장한 행 ${rows.length}`);
  }
  // 이전 실행 번호의 마지막 거래일·꼬리(이번 실행 시작 전 상태). 같은 실행 번호를 이어받을 때는 이미 갱신된 값이라 비교 기준이 달라지지 않도록 처음 읽은 것을 쓴다.
  const manStart = new Map<string, ManStock>(Object.entries(manifest.stocks).map(([k, v]) => [k, JSON.parse(JSON.stringify(v)) as ManStock]));

  let lastCheckpoint = Date.now(), lastLog = 0, doneSince = 0, noOverlap = 0, newRows = 0, revRows = 0, emptyStocks = 0;
  const gaps: string[] = [];
  const flush = async (why: string): Promise<void> => {
    const body = encode(rows);
    await upload(runFile, body);
    manifest.updatedAt = new Date().toISOString();
    const entry = { runId: RUN_ID, file: `${RUN_ID}.parquet`, rows: rows.length, sha256: sha(body), bytes: body.byteLength };
    const i = manifest.runs.findIndex((r) => r.runId === RUN_ID);
    if (i >= 0) manifest.runs[i] = entry; else manifest.runs.push(entry);
    await upload(`${FWD_FRGN_PREFIX}/${FWD_MANIFEST_FILE}`, new TextEncoder().encode(JSON.stringify(manifest)));
    await upload(`${FWD_FRGN_PREFIX}/${FWD_PROGRESS_FILE}`, new TextEncoder().encode(JSON.stringify(progress)));
    lastCheckpoint = Date.now(); doneSince = 0;
    console.log(`  [저장] ${why}: 이번 실행 행 ${rows.length}, 완료 ${Object.values(progress.stocks).filter((s) => s.done).length}/${codes.length}종목, 이번 회차 쓴 ${mib(io.writeBytes)} MiB, KST ${kst()}`);
    if (io.writeBytes > FWD_FRGN_WRITE_BUDGET_BYTES * FWD_WRITE_GUARD_FACTOR) run.stop = "쓰기 누적 예산 초과";
  };

  for (const code of codes) {
    if (run.stop) break;
    if (progress.stocks[code]?.done) continue;
    const body = await callKis(run, T0, FWD_RUN_MAX_MS, `소진율 ${code}`, FWD_DAILY_PATH, FWD_DAILY_TR, { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: code, FID_PERIOD_DIV_CODE: "D", FID_ORG_ADJ_PRC: "0" });
    if (body === null) { if (run.stop) break; continue; }
    progress.requests++;
    const out = rowsOf(body, ["output", "output2", "output1"]).filter((r: Rec) => r.stck_bsop_date).map((r) => ({ d: iso8(String(r.stck_bsop_date)), ehrt: num(r.hts_frgn_ehrt), ntby: num(r.frgn_ntby_qty) })).sort((a, b) => (a.d < b.d ? -1 : 1));
    const st: StockProg = { done: true, rows: 0, revs: 0, gap: null, empty: out.length === 0 };
    if (out.length === 0) emptyStocks++;
    if (out.length > FWD_DAILY_ROWS) console.log(`  [경고] ${code}: 응답 ${out.length}행(상한 ${FWD_DAILY_ROWS} 초과)`);
    const base = manStart.get(code), cur = manifest.stocks[code] ?? { last_date: "", tail: [] };
    const baseTail = new Map<string, number | null>(base?.tail ?? []);
    const lastDate = base?.last_date ?? "";
    if (lastDate && out.length && out[0].d > lastDate) {
      // 겹침 없음: 사이에 열린 거래일이 있는지 확인한다.
      noOverlap++;
      const between = (await openDays(addDays(lastDate, 1), addDays(out[0].d, -1))).length;
      if (between > 0) { st.gap = `${lastDate}~${out[0].d} 사이 열린 거래일 ${between}일`; gaps.push(`${code} ${st.gap}`); }
    }
    for (const r of out) {
      if (!lastDate || r.d > lastDate) { rows.push({ stock_code: code, trade_date: r.d, ehrt: r.ehrt, ntby: r.ntby, rev: 0 }); st.rows++; newRows++; }
      else if (baseTail.has(r.d) && baseTail.get(r.d) !== r.ehrt) { rows.push({ stock_code: code, trade_date: r.d, ehrt: r.ehrt, ntby: r.ntby, rev: 1 }); st.revs++; revRows++; }
    }
    if (out.length) {
      const merged = new Map<string, number | null>([...(cur.tail ?? [])]);
      for (const r of out) merged.set(r.d, r.ehrt);
      const tail = [...merged.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(-TAIL);
      manifest.stocks[code] = { last_date: tail[tail.length - 1][0] > (cur.last_date || "") ? tail[tail.length - 1][0] : cur.last_date, tail };
    }
    progress.stocks[code] = st; doneSince++;
    if (run.req - lastLog >= FWD_LOG_EVERY_REQ) { lastLog = run.req; console.log(`  진행: 요청 ${run.req}, 완료 ${Object.values(progress.stocks).filter((s) => s.done).length}/${codes.length}종목, KST ${kst()}, 경과 ${((Date.now() - T0) / 60e3).toFixed(1)}분`); }
    if (Date.now() - lastCheckpoint >= FWD_CHECKPOINT_MS && doneSince > 0) await flush("체크포인트");
  }
  await flush(run.stop ? `중단(${run.stop})` : "완료");

  const doneN = Object.values(progress.stocks).filter((s) => s.done).length;
  const lat = [...run.latenciesMs].sort((a, b) => a - b);
  const byDate = new Map<string, number>();
  for (const r of rows) if (r.rev === 0) byDate.set(r.trade_date, (byDate.get(r.trade_date) ?? 0) + 1);
  const dates = [...byDate.keys()].sort();
  const storageEnd = await storageTotal();
  console.log(`\n=== 소진율 수집 결과 (실행 번호 ${RUN_ID}) ===`);
  console.log(`대상 ${codes.length}종목, 완료 ${doneN}종목, 중단 사유 ${run.stop ?? "없음"} | 응답 행이 없는 종목 ${emptyStocks}개 | 새 행 ${newRows}(거래일 ${dates.length}일 ${dates[0] ?? "-"}~${dates[dates.length - 1] ?? "-"}), 수정 행(rev=1) ${revRows}, 겹침 없는 종목 ${noOverlap}개, 공백(GAP) ${gaps.length}건${gaps.length ? `: ${gaps.slice(0, 10).join("; ")}` : ""}`);
  console.log(`호출 ${run.req}회(재시도 포함), 오류 ${run.errors}, rate limit ${run.rlEvents}회, 지연 중앙값 ${lat[Math.floor(lat.length / 2)] ?? "-"}ms, 순차 평균 ${(((Date.now() - T0) / 1000) / Math.max(run.req, 1)).toFixed(2)}초/호출, 소요 ${((Date.now() - T0) / 60e3).toFixed(1)}분`);
  console.log(`일자별 행 수(상위): ${dates.slice(-5).map((d) => `${d} ${byDate.get(d)}`).join(" | ")}`);
  const man = manifest.runs[manifest.runs.length - 1];
  console.log(`저장 파일: ${runFile} ${man ? `${man.rows}행 ${man.bytes} B(행당 ${(man.bytes / Math.max(man.rows, 1)).toFixed(1)} B) SHA-256 ${man.sha256.slice(0, 16)}…` : "-"}`);
  console.log(`Storage 총량: 시작 ${mib(storageStart)} → 끝 ${mib(storageEnd)} MiB (+${mib(storageEnd - storageStart)} MiB, 상한 ${mib(FWD_STORAGE_CAP_BYTES)} MiB 안 ${storageEnd < FWD_STORAGE_CAP_BYTES ? "예" : "아니오"}) | 이번 회차 Storage 읽기 ${mib(io.readBytes)} MiB(${io.reads}건), 쓰기 ${mib(io.writeBytes)} MiB(${io.writes}건) | 연구 데이터 표 DB 쓰기 0 | DART 0 | 소요 ${((Date.now() - T0) / 60e3).toFixed(1)}분`);
  if (run.stop || doneN < codes.length) { console.log(`미완료 — 같은 실행 번호(${RUN_ID})로 다시 실행하면 이어받는다`); process.exitCode = run.stop ? 2 : 0; }
}
main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });
