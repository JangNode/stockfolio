/**
 * [임시 연구 — 병합 금지] 연구 LC 0단계: 069500 원주가(raw_close) 보조 파일 구축. etf_daily_prices의 069500 행이 2026-10-16에서 끝나 스냅샷 데이터 종료일(2026-10-26)과 기간이 어긋나는 문제를 메운다.
 * 기존 행(etf_daily_prices)은 그대로 복사하고, 그 뒤 데이터 종료일까지의 KOSPI 거래일만 KRX etp/etf_bydd_trd(069500의 TDD_CLSPRC)로 채운다. 요청은 빠진 거래일 수만큼(상한 BENCH_AUX_KRX_CAP).
 * DB·Storage 쓰기 0, 가격 Parquet 다운로드 0. KST 14:00~15:40에는 KRX를 부르지 않고 종료한다. 키 값은 출력하지 않는다.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getIndexPriceSeries } from "@/lib/betaPriceHistoryStorage";
import { SEASON_STOCK_CODE } from "@/lib/seasonalityConfig";
import { BENCH_AUX_KRX_CAP, BENCH_AUX_KRX_GAP_MS, BENCH_AUX_OVERLAP_DAYS, BENCH_AUX_FILE, BENCH_AUX_END, BENCH_AUX_BLOCK_FROM_KST_MIN, BENCH_AUX_BLOCK_TO_KST_MIN } from "@/lib/benchmarkAuxConfig";
import { selectAll, dbRead } from "./researchHarness";

const BASE = "https://data-dbg.krx.co.kr/svc/apis";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const num = (s: string | undefined): number | null => { const n = Number(String(s ?? "").replace(/,/g, "")); return String(s ?? "").trim() !== "" && Number.isFinite(n) ? n : null; };
const kstMin = (): number => { const k = new Date(Date.now() + 9 * 3_600_000); return k.getUTCHours() * 60 + k.getUTCMinutes(); };

async function main(): Promise<void> {
  console.log(`069500 보조 파일 구축 시작: ${new Date().toISOString()} (KST 분 ${kstMin()})`);
  const rows = await selectAll<{ trade_date: string; raw_close: number | null; adj_close: number | null }>("etf_daily_prices(069500)", (f, t) => supabaseAdmin.from("etf_daily_prices").select("trade_date, raw_close, adj_close").eq("code", SEASON_STOCK_CODE).lte("trade_date", BENCH_AUX_END).order("trade_date").range(f, t));
  const have = rows.filter((r) => r.raw_close !== null).map((r) => ({ d: r.trade_date, raw: Number(r.raw_close) }));
  const last = have[have.length - 1].d;
  console.log(`etf_daily_prices(069500): 전체 ${rows.length}행, raw_close 있는 행 ${have.length}개 ${have[0].d}~${last}, raw_close가 비어 있는 행 ${rows.length - have.length}개`);

  // 겹치는 구간 검증: etf_krx_daily(KRX tdd_clsprc, 연구용 표)와 etf_daily_prices.raw_close가 같은지(같은 정의여야 KRX 값을 이어 붙일 수 있다).
  const krxRows = await selectAll<{ bas_dd: string; tdd_clsprc: number | null }>("etf_krx_daily(069500)", (f, t) => supabaseAdmin.from("etf_krx_daily").select("bas_dd, tdd_clsprc").eq("isu_cd", SEASON_STOCK_CODE).order("bas_dd").range(f, t));
  const krxMap = new Map(krxRows.filter((r) => r.tdd_clsprc !== null).map((r) => [r.bas_dd, Number(r.tdd_clsprc)]));
  const haveMap = new Map(have.map((x) => [x.d, x.raw]));
  const both = [...krxMap.keys()].filter((d) => haveMap.has(d)).sort();
  const recent = both.slice(-BENCH_AUX_OVERLAP_DAYS);
  const diffs = recent.filter((d) => Math.abs(krxMap.get(d)! - haveMap.get(d)!) > 1e-9);
  console.log(`etf_krx_daily(069500): ${krxRows.length}행 ${krxRows[0]?.bas_dd}~${krxRows[krxRows.length - 1]?.bas_dd} | 두 표가 모두 있는 날 ${both.length}일 중 최근 ${recent.length}일에서 종가 불일치 ${diffs.length}일${diffs.length ? ` (${diffs.slice(0, 5).map((d) => `${d}: ${krxMap.get(d)} vs ${haveMap.get(d)}`).join(", ")})` : ""}`);
  if (diffs.length) throw new Error("KRX 종가와 etf_daily_prices.raw_close가 겹치는 날에 다릅니다 — 정의가 달라 이어 붙이지 않고 중단합니다");

  const kospi = await getIndexPriceSeries("KOSPI", "2026-09-01", BENCH_AUX_END);
  dbRead["beta_price_history(KOSPI)"] = kospi.length;
  const missing = kospi.map((p) => p.tradeDate).filter((d) => d > last && d <= BENCH_AUX_END);
  console.log(`KOSPI 거래일 기준 빠진 날(${last} 뒤 ~ ${BENCH_AUX_END}): ${missing.length}일 ${missing.join(", ") || "없음"}`);

  const ext: { d: string; raw: number; src: string }[] = [];
  let requests = 0;
  if (missing.length) {
    const km = kstMin();
    if (km >= BENCH_AUX_BLOCK_FROM_KST_MIN && km < BENCH_AUX_BLOCK_TO_KST_MIN) throw new Error(`KST 14:00~15:40에는 KRX를 호출하지 않는다(현재 KST 분 ${km}) — 호출 0건으로 종료`);
    const key = process.env.KRX_API_KEY;
    if (!key) throw new Error("KRX_API_KEY 환경변수가 필요합니다.");
    if (missing.length > BENCH_AUX_KRX_CAP) throw new Error(`빠진 날 ${missing.length}일이 요청 상한 ${BENCH_AUX_KRX_CAP}을 넘습니다`);
    for (const d of missing) {
      const km2 = kstMin();
      if (km2 >= BENCH_AUX_BLOCK_FROM_KST_MIN && km2 < BENCH_AUX_BLOCK_TO_KST_MIN) throw new Error(`도중에 KST 14:00 금지 시간대에 들어섰다(${d}에서 중단, 이미 받은 ${ext.length}일은 저장하지 않음)`);
      requests++;
      await sleep(BENCH_AUX_KRX_GAP_MS);
      const res = await fetch(`${BASE}/etp/etf_bydd_trd?basDd=${d.replace(/-/g, "")}`, { headers: { AUTH_KEY: key } });
      const text = await res.text();
      let j: { OutBlock_1?: Record<string, string>[] } | null = null;
      try { j = JSON.parse(text) as { OutBlock_1?: Record<string, string>[] }; } catch { j = null; }
      const block = j?.OutBlock_1 ?? [];
      const row = block.find((x) => x.ISU_CD === SEASON_STOCK_CODE);
      const px = num(row?.TDD_CLSPRC);
      console.log(`  KRX ${d}: HTTP ${res.status}, 응답 ${block.length}행, 069500 종가 ${px ?? "없음"}`);
      if (res.status !== 200 || px === null) throw new Error(`${d} 응답 이상(HTTP ${res.status}, 069500 종가 ${px}) — 중단(파일 만들지 않음)`);
      ext.push({ d, raw: px, src: "KRX etf_bydd_trd TDD_CLSPRC" });
    }
  }

  const merged = [...have.map((x) => ({ d: x.d, raw: x.raw, src: "etf_daily_prices.raw_close" })), ...ext];
  for (let i = 1; i < merged.length; i++) if (!(merged[i].d > merged[i - 1].d)) throw new Error(`날짜 순서 이상: ${merged[i - 1].d} → ${merged[i].d}`);
  if (merged[merged.length - 1].d !== BENCH_AUX_END) throw new Error(`보조 파일 마지막 날짜가 ${merged[merged.length - 1].d}로 ${BENCH_AUX_END}이 아닙니다`);
  const body = JSON.stringify({ code: SEASON_STOCK_CODE, kind: "raw_close", dataEnd: BENCH_AUX_END, note: "etf_daily_prices.raw_close 전부 + 그 뒤 빠진 거래일을 KRX etp/etf_bydd_trd TDD_CLSPRC로 채움(분배금 미반영 원주가)", rows: merged.map((x) => [x.d, x.raw, x.src === "etf_daily_prices.raw_close" ? 0 : 1]) });
  await fs.mkdir(path.dirname(BENCH_AUX_FILE), { recursive: true });
  await fs.writeFile(BENCH_AUX_FILE, body);
  const buf = await fs.readFile(BENCH_AUX_FILE);
  console.log(`보조 파일 ${BENCH_AUX_FILE}: ${merged.length}행 ${merged[0].d}~${merged[merged.length - 1].d} | 바이트 ${buf.byteLength} | SHA-256 ${createHash("sha256").update(buf).digest("hex")}`);
  console.log(`채운 날 ${ext.length}일: ${ext.map((x) => `${x.d} ${x.raw}`).join(", ") || "없음"} | KRX 요청 ${requests}건, 받은 바이트(응답 본문) 확인 불가 — 요청당 ETF 일별 목록 1건`);
  console.log(`Supabase 읽은 행: ${Object.entries(dbRead).map(([k, v]) => `${k} ${v}`).join(" | ")} | Supabase 쓴 행 0 | Storage 쓰기 0 | 가격 Parquet 다운로드 0`);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });
