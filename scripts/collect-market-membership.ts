/**
 * [임시 연구 — 병합 금지] 월말 시장 구분(KOSPI/KOSDAQ) 수집. KRX Open API 외 외부 요청 0, DB 쓰기 0(Storage Parquet만).
 * 2010-01~2026-10 매월 마지막 거래일(가격 Parquet 달력 기준)마다 KOSPI·KOSDAQ 일별매매정보를 1회씩 받아
 * (trade_date, stock_code, market)만 research/market_membership/month_end.parquet에 저장한다. 이미 저장된 (날짜, 시장)은 다시 받지 않는다(이어받기).
 * 기록: research/market-membership-collect.md.
 */
import { parquetReadObjects } from "hyparquet";
import { parquetWriteBuffer } from "hyparquet-writer";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadAllStockSeriesFromParquet } from "@/lib/stockDailyPricesStorage";
import { INVESTOR_FLOW_STOCK_STORE_BUCKET } from "@/lib/investorFlowConfig";
import { MM_KRX_BASE_URL, MM_ENDPOINTS, MM_FROM_MONTH, MM_TO_MONTH, MM_REQUEST_CAP, MM_REQUEST_GAP_MS, MM_RETRY_COUNT, MM_RETRY_DELAY_MS, MM_PARQUET_PATH, MM_LOG_PATH } from "@/lib/marketMembershipConfig";

interface Row { trade_date: string; stock_code: string; market: string }
interface Log { requests: number; empty: { date: string; market: string }[]; failed: { date: string; market: string; error: string }[]; normalized: number }

const T0 = Date.now();
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const bucket = () => supabaseAdmin.storage.from(INVESTOR_FLOW_STOCK_STORE_BUCKET);

/** 6자리 단축코드로 정규화: ISU_SRT_CD가 있으면 그 값, ISU_CD가 12자리 ISIN(KR7xxxxxx...)이면 4~9번째 자리. */
function shortCode(r: { ISU_CD?: string; ISU_SRT_CD?: string }): { code: string; normalized: boolean } | null {
  if (r.ISU_SRT_CD && r.ISU_SRT_CD.length === 6) return { code: r.ISU_SRT_CD, normalized: r.ISU_SRT_CD !== r.ISU_CD };
  if (!r.ISU_CD) return null;
  if (r.ISU_CD.length === 6) return { code: r.ISU_CD, normalized: false };
  if (r.ISU_CD.length === 12 && r.ISU_CD.startsWith("KR")) return { code: r.ISU_CD.slice(3, 9), normalized: true };
  return null;
}

async function main(): Promise<void> {
  const apiKey = process.env.KRX_API_KEY;
  if (!apiKey) throw new Error("KRX_API_KEY 환경 변수가 없습니다.");
  console.log(`월말 시장 구분 수집 시작: ${new Date().toISOString()}`);

  const series = await loadAllStockSeriesFromParquet(2010, new Date().getUTCFullYear());
  const calSet = new Set<string>();
  for (const rows of series.values()) for (const r of rows) if (r.tradeDate >= "2010-01-01") calSet.add(r.tradeDate);
  series.clear();
  const CAL = [...calSet].sort();
  const monthEnds: string[] = [];
  for (let k = 0; k < CAL.length; k++) if (k + 1 === CAL.length || CAL[k].slice(0, 7) !== CAL[k + 1].slice(0, 7)) monthEnds.push(CAL[k]);
  const targets = monthEnds.filter((d) => d.slice(0, 7) >= MM_FROM_MONTH && d.slice(0, 7) <= MM_TO_MONTH);
  console.log(`대상 월말 ${targets.length}개 (${targets[0]}~${targets[targets.length - 1]}) × 시장 2 = ${targets.length * 2}건`);

  // 이어받기: 기존 Parquet·기록
  let rows: Row[] = [];
  let log: Log = { requests: 0, empty: [], failed: [], normalized: 0 };
  {
    const { data } = await bucket().download(MM_PARQUET_PATH);
    if (data) rows = (await parquetReadObjects({ file: await data.arrayBuffer() })) as Row[];
    const { data: lg } = await bucket().download(MM_LOG_PATH);
    if (lg) log = { ...JSON.parse(await lg.text()), failed: [] };
  }
  const done = new Set(rows.map((r) => `${r.trade_date}|${r.market}`));
  for (const e of log.empty) done.add(`${e.date}|${e.market}`);
  console.log(`기존 저장 ${rows.length}행, 완료된 (날짜, 시장) ${done.size}개, 이전 요청 ${log.requests}건`);

  let stop = false;
  for (const d of targets) {
    for (const [market, ep] of MM_ENDPOINTS) {
      if (stop || done.has(`${d}|${market}`)) continue;
      let got: { ISU_CD?: string; ISU_SRT_CD?: string }[] | null = null, lastErr = "";
      for (let a = 0; a <= MM_RETRY_COUNT; a++) {
        if (log.requests >= MM_REQUEST_CAP) { stop = true; break; }
        log.requests++;
        try {
          const res = await fetch(`${MM_KRX_BASE_URL}/${ep}?basDd=${d.replaceAll("-", "")}`, { headers: { AUTH_KEY: apiKey } });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          got = ((await res.json()) as { OutBlock_1?: { ISU_CD?: string; ISU_SRT_CD?: string }[] }).OutBlock_1 ?? [];
          break;
        } catch (e) {
          lastErr = e instanceof Error ? e.message : String(e);
          await sleep(MM_RETRY_DELAY_MS);
        }
      }
      await sleep(MM_REQUEST_GAP_MS);
      if (got === null) { if (!stop) log.failed.push({ date: d, market, error: lastErr }); continue; }
      if (!got.length) { log.empty.push({ date: d, market }); continue; }
      const seen = new Set<string>();
      for (const r of got) {
        const sc = shortCode(r);
        if (!sc || seen.has(sc.code)) continue;
        seen.add(sc.code);
        if (sc.normalized) log.normalized++;
        rows.push({ trade_date: d, stock_code: sc.code, market });
      }
    }
  }
  if (stop) console.log(`요청 상한 ${MM_REQUEST_CAP}건에 닿아 멈춤(이어받기 가능)`);

  rows.sort((a, b) => (a.trade_date < b.trade_date ? -1 : a.trade_date > b.trade_date ? 1 : a.market < b.market ? -1 : a.market > b.market ? 1 : a.stock_code < b.stock_code ? -1 : 1));
  const buf = parquetWriteBuffer({ columnData: [
    { name: "trade_date", data: rows.map((r) => r.trade_date), type: "STRING" },
    { name: "stock_code", data: rows.map((r) => r.stock_code), type: "STRING" },
    { name: "market", data: rows.map((r) => r.market), type: "STRING" },
  ] });
  for (const [path, body, ct] of [[MM_PARQUET_PATH, buf, "application/octet-stream"], [MM_LOG_PATH, JSON.stringify(log), "application/json"]] as const) {
    let ok = false;
    for (let a = 0; a < 4 && !ok; a++) {
      const { error } = await bucket().upload(path, body, { contentType: ct, upsert: true });
      if (!error) ok = true; else { console.log(`업로드 재시도 ${path}: ${error.message}`); await sleep(3000 * 2 ** a); }
    }
    if (!ok) throw new Error(`업로드 실패 ${path}`);
  }
  const dates = new Set(rows.map((r) => r.trade_date));
  console.log(`\n=== 수집 결과 ===\n외부 요청(KRX, 재시도 포함, 누적) ${log.requests}건 | 저장 ${rows.length}행 (월말 ${dates.size}개, KOSPI ${rows.filter((r) => r.market === "KOSPI").length}행, KOSDAQ ${rows.filter((r) => r.market === "KOSDAQ").length}행) | Parquet ${buf.byteLength} B`);
  console.log(`빈 응답 ${log.empty.length}건${log.empty.length ? `: ${log.empty.map((e) => `${e.date} ${e.market}`).join(", ")}` : ""} | 실패 ${log.failed.length}건${log.failed.length ? `: ${log.failed.map((e) => `${e.date} ${e.market} ${e.error}`).join(", ")}` : ""} | 코드 정규화(ISIN·ISU_SRT_CD) ${log.normalized}건`);
  console.log(`DB 쓴 행 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
  if (log.failed.length) process.exit(1);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });
