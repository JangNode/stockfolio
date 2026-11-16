/**
 * [연구용 — 병합 금지] 분봉(1분봉) 앞으로 쌓기·12개월 백필: 시총 상위 30종목(고정 스냅샷 마지막 날 코스피 보통주 시총 순), inquire-time-dailychartprice(종료 시각부터 거꾸로 120행) 하루 4회 안팎.
 * 승인: docs/research/forward-data-plan.md(사용자 2026-11-17: 30종목으로 시작, 한 사본, 수집만). 날짜 **오름차순·날짜별로 30종목 전부** 받는다(KIS 분봉은 약 12개월 이내만 주는 이동 창이라 가장 오래된 날을 먼저 받아야 잃지 않는다). 연구 데이터 표 DB 쓰기 0(KIS 토큰 행 갱신 제외), 공시(DART) 사용 없음, 아티팩트로 올리지 않는다.
 * 저장: research/forward/minute/<종목>/<YYYY-MM>.parquet(trade_date, hhmm, open, high, low, close, volume, amount(누적대금)) + _progress.json(마지막 완료 날짜) + manifest.json + targets.json. 이어받기는 마지막 완료 날짜 다음 날부터, 그 달의 부분 월 파일을 다시 읽어 이어 붙인다.
 * 호출 금지 시간대(14:00~15:40, 03:50~06:20 KST)에는 30분 넘게 기다리지 않고 멈춘다(다시 실행하면 이어받는다). 키 값·응답 본문은 출력하지 않는다.
 */
import { createHash } from "node:crypto";
import { parquetWriteBuffer } from "hyparquet-writer";
import { parquetReadObjects } from "hyparquet";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadAllStockSeriesFromParquet } from "@/lib/stockDailyPricesStorage";
import { MM_PARQUET_PATH } from "@/lib/marketMembershipConfig";
import { FWD_FRGN_PREFIX, FWD_DAYS_FILE, FWD_MIN_PREFIX, FWD_PROGRESS_FILE, FWD_MANIFEST_FILE, FWD_TARGETS_FILE, FWD_MIN_PATH, FWD_MIN_TR, FWD_MIN_PAGE_ROWS, FWD_MIN_END_HHMMSS, FWD_MIN_START_HHMM, FWD_MIN_TOP_N, FWD_MIN_FROM, FWD_RUN_MAX_MS, FWD_MIN_CHECKPOINT_MS, FWD_STORAGE_CAP_BYTES, FWD_STORAGE_HEADROOM_BYTES, FWD_MIN_WRITE_BUDGET_BYTES, FWD_WRITE_GUARD_FACTOR, FWD_LOG_EVERY_REQ } from "@/lib/forwardDataConfig";
import { callKis, newKisRun, rowsOf, io, download, upload, storageTotal, kst, kstDate, mib, num, type Rec } from "@/lib/forwardCollectKit";

const T0 = Date.now();
type MRow = { d: number; hhmm: number; o: number; h: number; l: number; c: number; v: number; a: number };
interface StockStat { rows: number; days: number; emptyDays: string[]; shortDays: string[] }
interface Progress { startedAt: string; cursorDate: string | null; stocks: Record<string, StockStat>; requests: number; errors: number; runs: { startedAt: string; requests: number; stop: string | null }[] }
interface ManFile { rows: number; bytes: number; sha256: string; first: number; last: number }
interface Manifest { updatedAt: string; files: Record<string, ManFile> }
const run = newKisRun();
const text = (b: ArrayBuffer): string => new TextDecoder().decode(b);
const sha = (b: ArrayBuffer | Uint8Array): string => createHash("sha256").update(b instanceof ArrayBuffer ? new Uint8Array(b) : b).digest("hex");
const d8 = (iso: string): string => iso.replace(/-/g, "");
const hhmmssSub1m = (t: string): string => { const m = Number(t.slice(0, 2)) * 60 + Number(t.slice(2, 4)) - 1; return `${String(Math.floor(m / 60)).padStart(2, "0")}${String(m % 60).padStart(2, "0")}00`; };
const monthOf = (iso: string): string => iso.slice(0, 7);

function encode(rows: MRow[]): ArrayBuffer {
  const l = [...rows].sort((a, b) => a.d - b.d || a.hhmm - b.hhmm);
  return parquetWriteBuffer({ columnData: [
    { name: "trade_date", data: l.map((r) => r.d), type: "INT32" as const },
    { name: "hhmm", data: l.map((r) => r.hhmm), type: "INT32" as const },
    { name: "open", data: l.map((r) => r.o), type: "INT32" as const },
    { name: "high", data: l.map((r) => r.h), type: "INT32" as const },
    { name: "low", data: l.map((r) => r.l), type: "INT32" as const },
    { name: "close", data: l.map((r) => r.c), type: "INT32" as const },
    { name: "volume", data: l.map((r) => r.v), type: "INT32" as const },
    { name: "amount", data: l.map((r) => r.a), type: "DOUBLE" as const },
  ] });
}
async function decode(buf: ArrayBuffer): Promise<MRow[]> {
  return ((await parquetReadObjects({ file: buf })) as Record<string, unknown>[]).map((r) => ({ d: Number(r.trade_date), hhmm: Number(r.hhmm), o: Number(r.open), h: Number(r.high), l: Number(r.low), c: Number(r.close), v: Number(r.volume), a: Number(r.amount) }));
}

async function buildTargets(): Promise<{ codes: string[]; basis: string; mcapEok: Record<string, number> }> {
  const series = await loadAllStockSeriesFromParquet(2010, new Date().getUTCFullYear());
  let lastDate = "";
  for (const rows of series.values()) for (const r of rows) if (r.tradeDate > lastDate) lastDate = r.tradeDate;
  const mm = await download(MM_PARQUET_PATH);
  if (!mm) throw new Error(`${MM_PARQUET_PATH} 없음`);
  const mmRows = (await parquetReadObjects({ file: mm })) as { trade_date: string; stock_code: string; market: string }[];
  const mmDates = [...new Set(mmRows.map((r) => r.trade_date))].sort(), mmLast = mmDates.filter((d) => d <= lastDate).pop() ?? mmDates[mmDates.length - 1];
  const kospi = new Set(mmRows.filter((r) => r.trade_date === mmLast && r.market === "KOSPI").map((r) => r.stock_code));
  const cand: { code: string; mc: number }[] = [];
  for (const [code, rows] of series) {
    if (code[code.length - 1] !== "0" || !kospi.has(code)) continue;
    const r = rows.find((x) => x.tradeDate === lastDate);
    if (r && r.marketCapEok > 0) cand.push({ code, mc: r.marketCapEok });
  }
  cand.sort((a, b) => b.mc - a.mc || (a.code < b.code ? -1 : 1));
  const top = cand.slice(0, FWD_MIN_TOP_N);
  series.clear();
  return { codes: top.map((x) => x.code).sort(), basis: `고정 스냅샷 마지막 날 ${lastDate} 시총 순(코스피 보통주: 종목코드 끝자리 0, 월말 시장 목록 ${mmLast} 코스피), 후보 ${cand.length}종목 중 상위 ${FWD_MIN_TOP_N}`, mcapEok: Object.fromEntries(top.map((x) => [x.code, x.mc])) };
}

/** krx_trading_calendar에서 열린 거래일(표가 일부 기간만 채워져 있어 다른 출처와 합쳐 쓴다). */
async function calendarOpenDays(from: string, to: string): Promise<string[]> {
  const out: string[] = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await supabaseAdmin.from("krx_trading_calendar").select("trade_date, is_open").gte("trade_date", from).lte("trade_date", to).order("trade_date").range(off, off + 999);
    if (error) throw new Error(`krx_trading_calendar 읽기 실패: ${error.message}`);
    for (const r of data ?? []) if (r.is_open) out.push(String(r.trade_date));
    if (!data || data.length < 1000) break;
  }
  return out;
}
/** 소진율 수집 파일(실행별 Parquet)에 나온 거래일(KIS 응답의 날짜 = 열린 거래일). */
async function frgnDays(from: string, to: string): Promise<string[]> {
  const mb = await download(`${FWD_FRGN_PREFIX}/${FWD_MANIFEST_FILE}`);
  if (!mb) return [];
  const man = JSON.parse(text(mb)) as { runs: { file: string }[] };
  const set = new Set<string>();
  for (const r of man.runs) {
    const b = await download(`${FWD_FRGN_PREFIX}/${r.file}`);
    if (!b) continue;
    for (const row of (await parquetReadObjects({ file: b })) as Record<string, unknown>[]) { const d = String(row.trade_date); if (d >= from && d <= to) set.add(d); }
  }
  return [...set];
}
/**
 * 거래일 목록: 처음에 고정 스냅샷 가격 Parquet의 거래일 ∪ krx_trading_calendar 열린 날 ∪ 소진율 수집 파일의 날짜로 만들어 `days.json`에 저장하고,
 * 이후 실행은 저장본을 읽어 마지막 날짜 뒤만 (캘린더 표 ∪ 소진율 수집 날짜)로 늘린다.
 */
async function tradingDays(from: string, to: string): Promise<string[]> {
  const path = `${FWD_MIN_PREFIX}/${FWD_DAYS_FILE}`, sb = await download(path);
  const set = new Set<string>();
  let builtTo = "";
  if (sb) { const j = JSON.parse(text(sb)) as { to: string; days: string[] }; for (const d of j.days) set.add(d); builtTo = j.to; }
  else {
    const series = await loadAllStockSeriesFromParquet(Number(from.slice(0, 4)), Number(to.slice(0, 4)));
    for (const rows of series.values()) for (const r of rows) if (r.tradeDate >= from && r.tradeDate <= to) set.add(r.tradeDate);
    series.clear();
  }
  const extFrom = builtTo && builtTo > from ? builtTo : from;
  for (const d of await calendarOpenDays(extFrom, to)) set.add(d);
  for (const d of await frgnDays(extFrom, to)) set.add(d);
  const days = [...set].filter((d) => d >= from && d <= to).sort();
  await upload(path, new TextEncoder().encode(JSON.stringify({ from, to: days[days.length - 1] ?? to, days, builtAt: new Date().toISOString() })));
  return days;
}

/** 종목 하루: 종료 15:30부터 거꾸로 호출(9:00 행을 받을 때까지, 최대 6회). 응답이 다른 날짜 행으로 채워지는 마지막 호출이 있어 날짜가 맞는 행만 쓴다. 실패(중단)하면 null. */
async function collectDay(code: string, date: string): Promise<MRow[] | null> {
  const got = new Map<number, MRow>();
  let end = FWD_MIN_END_HHMMSS;
  for (let call = 0; call < 6; call++) {
    const body = await callKis(run, T0, FWD_RUN_MAX_MS, `분봉 ${code} ${date} ${end}`, FWD_MIN_PATH, FWD_MIN_TR, { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: code, FID_INPUT_HOUR_1: end, FID_INPUT_DATE_1: d8(date), FID_PW_DATA_INCU_YN: "Y", FID_FAKE_TICK_INCU_YN: "" });
    if (body === null) { if (run.stop) return null; call--; continue; }
    const rows = rowsOf(body, ["output2", "output", "output1"]).filter((r: Rec) => String(r.stck_bsop_date) === d8(date) && r.stck_cntg_hour);
    let minT = "999999";
    for (const r of rows) {
      const t = String(r.stck_cntg_hour), hhmm = Number(t.slice(0, 4));
      if (t < minT) minT = t;
      got.set(hhmm, { d: Number(d8(date)), hhmm, o: num(r.stck_oprc) ?? 0, h: num(r.stck_hgpr) ?? 0, l: num(r.stck_lwpr) ?? 0, c: num(r.stck_prpr) ?? 0, v: num(r.cntg_vol) ?? 0, a: num(r.acml_tr_pbmn) ?? 0 });
    }
    if (!rows.length || Number(minT.slice(0, 4)) <= FWD_MIN_START_HHMM) break;
    end = hhmmssSub1m(minT);
    if (rows.length < FWD_MIN_PAGE_ROWS && call > 0) break;
  }
  return [...got.values()];
}

async function main(): Promise<void> {
  console.log(`분봉 앞으로 쌓기 시작: ${new Date().toISOString()} (KST ${kst()}) | 백필 시작 ${FWD_MIN_FROM} | 회차 상한 ${(FWD_RUN_MAX_MS / 3600e3).toFixed(2)}시간 | 저장 ${FWD_MIN_PREFIX}/ (한 사본)`);
  const storageStart = await storageTotal();
  console.log(`Storage 총량(시작): ${mib(storageStart)} MiB / 상한 ${mib(FWD_STORAGE_CAP_BYTES)} MiB (여유 ${mib(FWD_STORAGE_CAP_BYTES - storageStart)} MiB)`);
  if (storageStart > FWD_STORAGE_CAP_BYTES - FWD_STORAGE_HEADROOM_BYTES) throw new Error("Storage 총량이 상한에 가까워 시작하지 않는다 — 보고한다");

  let targets: { codes: string[]; basis: string; mcapEok: Record<string, number> };
  const tb = await download(`${FWD_MIN_PREFIX}/${FWD_TARGETS_FILE}`);
  if (tb) { targets = JSON.parse(text(tb)); console.log(`대상(저장본): ${targets.codes.length}종목 — ${targets.basis}`); }
  else {
    targets = await buildTargets();
    await upload(`${FWD_MIN_PREFIX}/${FWD_TARGETS_FILE}`, new TextEncoder().encode(JSON.stringify({ ...targets, builtAt: new Date().toISOString() })));
    console.log(`대상(새로 만듦): ${targets.codes.length}종목 — ${targets.basis}`);
  }
  const codes = targets.codes;

  // ---- 날짜: 백필 시작일 ~ 마지막 완료 거래일(KST 16시 전이면 어제까지) ----
  const now = new Date(), todayKst = kstDate(now), hourKst = Number(kst(now).slice(0, 2));
  const lastDay = hourKst >= 16 ? todayKst : new Date(Date.parse(todayKst) - 86_400_000).toISOString().slice(0, 10);
  const days = await tradingDays(FWD_MIN_FROM, lastDay);
  const calSpan = (Date.parse(lastDay) - Date.parse(FWD_MIN_FROM)) / 86_400_000;
  console.log(`수집 날짜: ${FWD_MIN_FROM}~${lastDay} 거래일 ${days.length}일(가격 스냅샷 ∪ 거래일 캘린더 ∪ 소진율 수집 날짜), 달력 ${calSpan.toFixed(0)}일`);
  if (days.length < calSpan * 0.55) throw new Error(`거래일 목록 ${days.length}일이 달력 ${calSpan.toFixed(0)}일에 비해 너무 적다 — 중단하고 보고한다`);

  // ---- 진행·매니페스트 ----
  const pb = await download(`${FWD_MIN_PREFIX}/${FWD_PROGRESS_FILE}`), mbf = await download(`${FWD_MIN_PREFIX}/${FWD_MANIFEST_FILE}`);
  const progress: Progress = pb ? (JSON.parse(text(pb)) as Progress) : { startedAt: new Date().toISOString(), cursorDate: null, stocks: {}, requests: 0, errors: 0, runs: [] };
  const manifest: Manifest = mbf ? (JSON.parse(text(mbf)) as Manifest) : { updatedAt: "", files: {} };
  for (const c of codes) progress.stocks[c] ??= { rows: 0, days: 0, emptyDays: [], shortDays: [] };
  const remaining = days.filter((d) => progress.cursorDate === null || d > progress.cursorDate);
  console.log(`이어받기: 마지막 완료 날짜 ${progress.cursorDate ?? "없음"}, 남은 날짜 ${remaining.length}일 (${remaining[0] ?? "-"}~${remaining[remaining.length - 1] ?? "-"}), 종목 ${codes.length}개 → 예상 호출 약 ${remaining.length * codes.length * 4}회`);
  const baseReq = progress.requests, baseErr = progress.errors;
  const runLog = { startedAt: new Date().toISOString(), requests: 0, stop: null as string | null };
  progress.runs.push(runLog);

  // 월 버퍼(종목 × 월): 진행 중인 달의 부분 파일이 있으면 읽어 이어 붙인다.
  const buf = new Map<string, MRow[]>();
  const key = (c: string, m: string): string => `${c}/${m}`;
  const loadPartial = async (m: string): Promise<void> => {
    if (!progress.cursorDate || monthOf(progress.cursorDate) !== m) return;
    for (const c of codes) {
      const b = await download(`${FWD_MIN_PREFIX}/${key(c, m)}.parquet`);
      if (b) buf.set(key(c, m), await decode(b));
    }
    console.log(`이어받기: ${m} 부분 월 파일 ${buf.size}개 읽음`);
  };
  const flush = async (months: Set<string>, why: string): Promise<void> => {
    for (const [k, rows] of buf) {
      const m = k.slice(k.indexOf("/") + 1);
      if (!months.has(m) || rows.length === 0) continue;
      const body = encode(rows), ds = rows.map((r) => r.d);
      await upload(`${FWD_MIN_PREFIX}/${k}.parquet`, body);
      manifest.files[k] = { rows: rows.length, bytes: body.byteLength, sha256: sha(body), first: Math.min(...ds), last: Math.max(...ds) };
    }
    manifest.updatedAt = new Date().toISOString();
    await upload(`${FWD_MIN_PREFIX}/${FWD_MANIFEST_FILE}`, new TextEncoder().encode(JSON.stringify(manifest)));
    runLog.requests = run.req; progress.requests = baseReq + run.req; progress.errors = baseErr + run.errors;
    await upload(`${FWD_MIN_PREFIX}/${FWD_PROGRESS_FILE}`, new TextEncoder().encode(JSON.stringify(progress)));
    console.log(`  [저장] ${why}: 마지막 완료 날짜 ${progress.cursorDate}, 월 파일 ${Object.keys(manifest.files).length}개, 이번 회차 쓴 ${mib(io.writeBytes)} MiB, 요청 ${run.req}, KST ${kst()}`);
    if (io.writeBytes > FWD_MIN_WRITE_BUDGET_BYTES * FWD_WRITE_GUARD_FACTOR) run.stop = "쓰기 누적 예산 초과";
  };

  let lastCheckpoint = Date.now(), lastLog = 0, curMonth = remaining.length ? monthOf(remaining[0]) : "";
  if (curMonth) await loadPartial(curMonth);
  for (const date of remaining) {
    if (run.stop) break;
    const m = monthOf(date);
    if (m !== curMonth) { await flush(new Set([curMonth]), `${curMonth} 월 완료`); for (const k of [...buf.keys()]) if (k.endsWith(`/${curMonth}`)) buf.delete(k); curMonth = m; }
    let ok = true;
    const staged: [string, MRow[]][] = [];
    for (const code of codes) {
      const rows = await collectDay(code, date);
      if (rows === null) { ok = false; break; }
      staged.push([code, rows]);
      if (run.req - lastLog >= FWD_LOG_EVERY_REQ) { lastLog = run.req; console.log(`  진행: ${date} ${code}, 요청 ${run.req}, KST ${kst()}, 경과 ${((Date.now() - T0) / 60e3).toFixed(1)}분`); }
    }
    if (!ok) break; // 하루가 끝까지 안 받아졌으면 그날은 버리고(부분 저장 없음) 다음 실행이 그날부터 다시 받는다.
    for (const [code, rows] of staged) {
      const st = progress.stocks[code];
      const k = key(code, m), list = buf.get(k) ?? [];
      const dn = Number(d8(date));
      const keep = list.filter((r) => r.d !== dn);
      buf.set(k, [...keep, ...rows]);
      if (rows.length === 0) st.emptyDays.push(date); else { st.rows += rows.length; st.days++; if (rows.length < 300) st.shortDays.push(`${date}:${rows.length}`); }
    }
    progress.cursorDate = date;
    if (Date.now() - lastCheckpoint >= FWD_MIN_CHECKPOINT_MS) { await flush(new Set([m]), "체크포인트"); lastCheckpoint = Date.now(); }
  }
  runLog.stop = run.stop;
  await flush(new Set(curMonth ? [curMonth] : []), run.stop ? `중단(${run.stop})` : "완료");

  const done = remaining.filter((d) => progress.cursorDate !== null && d <= progress.cursorDate).length;
  const lat = [...run.latenciesMs].sort((a, b) => a - b);
  const files = Object.values(manifest.files);
  const totRows = files.reduce((a, f) => a + f.rows, 0), totBytes = files.reduce((a, f) => a + f.bytes, 0);
  const storageEnd = await storageTotal();
  console.log(`\n=== 분봉 수집 결과 (이번 회차) ===`);
  console.log(`이번 회차 완료 날짜 ${done}/${remaining.length}일(마지막 완료 ${progress.cursorDate}), 중단 사유 ${run.stop ?? "없음"} | 호출 ${run.req}회(재시도 포함), 오류 ${run.errors}, rate limit ${run.rlEvents}회, 지연 중앙값 ${lat[Math.floor(lat.length / 2)] ?? "-"}ms, 순차 평균 ${(((Date.now() - T0) / 1000) / Math.max(run.req, 1)).toFixed(2)}초/호출, 소요 ${((Date.now() - T0) / 60e3).toFixed(1)}분`);
  console.log(`누적 저장: 월 파일 ${files.length}개, ${totRows}행, ${(totBytes / 1048576).toFixed(2)} MiB(행당 ${(totBytes / Math.max(totRows, 1)).toFixed(1)} B)`);
  const emptyN = Object.values(progress.stocks).reduce((a, s) => a + s.emptyDays.length, 0), shortN = Object.values(progress.stocks).reduce((a, s) => a + s.shortDays.length, 0);
  console.log(`누락: 응답 행이 없는 종목-날짜 ${emptyN}건, 300행 미만인 종목-날짜 ${shortN}건 | 종목별 완료 날짜 수 ${codes.map((c) => `${c}:${progress.stocks[c].days}`).join(" ")}`);
  console.log(`Storage 총량: 시작 ${mib(storageStart)} → 끝 ${mib(storageEnd)} MiB (+${mib(storageEnd - storageStart)} MiB, 상한 ${mib(FWD_STORAGE_CAP_BYTES)} MiB 안 ${storageEnd < FWD_STORAGE_CAP_BYTES ? "예" : "아니오"}) | 이번 회차 Storage 읽기 ${mib(io.readBytes)} MiB(${io.reads}건), 쓰기 ${mib(io.writeBytes)} MiB(${io.writes}건) | 연구 데이터 표 DB 쓰기 0 | DART 0`);
  if (run.stop || done < remaining.length) { console.log(`미완료 — 다시 실행하면 ${progress.cursorDate ?? FWD_MIN_FROM} 다음 날부터 이어받는다`); process.exitCode = run.stop ? 2 : 0; }
}
main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });
