/**
 * [임시 조사 — 병합 금지, 백테스트 없음, DB 쓰기 0, 키 값 출력 금지] 종목별 공매도(거래량·거래대금·잔고)·신용잔고 데이터 확보 가능성 조사.
 * 외부 요청(KRX + KIS 시도) 총 SC_PROBE_REQUEST_CAP건 이하. 14:00~14:30 KST에는 호출하지 않고 기다린다. 숫자와 표만 출력한다.
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { kisGetForResearch, getKisCallStats } from "@/lib/kis";
import { loadAllStockSeriesFromParquet } from "@/lib/stockDailyPricesStorage";
import { computeTrailingAvgTradingValue } from "@/lib/pitUniverse";
import { PIT_LIQUIDITY_LOOKBACK_DAYS, PIT_MIN_AVG_TRADING_VALUE_WON } from "@/lib/strategyBacktestSummaryConfig";
import { SCAN_CAP_EOK, SCAN_POOL_SIZE, SCAN_SMALL_MIN_MCAP_EOK, SCAN_SMALL_MIN_AVG_TV_WON, SCAN_SMALL_MIN_PRICE_WON } from "@/lib/signalScanConfig";
import { INVESTOR_FLOW_TOP_N } from "@/lib/investorFlowConfig";
import {
  SC_PROBE_REQUEST_CAP, SC_PROBE_KRX_GAP_MS, SC_PROBE_ANCHORS, SC_PROBE_LATEST, SC_PROBE_SHORT_WINDOW_DAYS, SC_PROBE_EARLIER, SC_PROBE_STOCK, SC_PROBE_DELISTED,
  SC_PROBE_DELISTED_ANCHOR, SC_PROBE_SMALL_PICK_DATE, SC_PROBE_BAN_WINDOWS, SC_BAN_PERIODS, SC_PROBE_KRX_PATHS, SC_PROBE_KRX_DATE, SC_PROBE_HEAD_ROWS,
  SC_PROBE_ROW_CHARS, SC_PROBE_BLOCK_UTC_FROM_MIN, SC_PROBE_BLOCK_UTC_TO_MIN, SC_PROBE_PARQUET_BYTES_PER_ROW, SC_PROBE_SEC_PER_REQ,
} from "@/lib/shortCreditProbeConfig";

const T0 = Date.now();
const MS_DAY = 86_400_000;
const SHORT = "/uapi/domestic-stock/v1/quotations/daily-short-sale";
const CREDIT = "/uapi/domestic-stock/v1/quotations/daily-credit-balance";
let krxReq = 0;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const used = (): number => krxReq + getKisCallStats().total;
const kst = (): string => new Date(Date.now() + 9 * 3600e3).toISOString().slice(11, 19);
const short = (v: unknown): string => JSON.stringify(v).slice(0, SC_PROBE_ROW_CHARS);
const ymd = (d: string): string => d.replace(/-/g, "");
const iso = (d: string): string => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
const addDays = (d: string, n: number): string => ymd(new Date(Date.parse(iso(d)) + n * MS_DAY).toISOString().slice(0, 10));
type Rec = Record<string, unknown>;
interface Call { label: string; ok: boolean; rows: number; fields: string; first?: string; last?: string; err?: string; arr?: Rec[]; arrKey?: string }
const calls: Call[] = [];

async function waitIfBlocked(): Promise<void> {
  for (;;) {
    const n = new Date(), m = n.getUTCHours() * 60 + n.getUTCMinutes();
    if (m >= SC_PROBE_BLOCK_UTC_FROM_MIN && m < SC_PROBE_BLOCK_UTC_TO_MIN) { console.log(`  [대기] KST ${kst()} — 14:00~14:30 호출 금지 시간대, 30초 후 재확인`); await sleep(30_000); } else return;
  }
}
async function kis(label: string, path: string, trId: string, params: Record<string, string>): Promise<Call | null> {
  if (used() >= SC_PROBE_REQUEST_CAP) { console.log(`\n[${label}] 요청 상한 도달 — 건너뜀`); return null; }
  await waitIfBlocked();
  console.log(`\n[KIS ${kst()}] ${label} (${trId}) 파라미터: ${JSON.stringify(params)}`);
  const c: Call = { label, ok: false, rows: 0, fields: "" };
  try {
    const body = await kisGetForResearch(path, trId, params);
    console.log(`  최상위 키: ${Object.keys(body).join(", ")} | rt_cd=${String(body.rt_cd)} msg_cd=${String(body.msg_cd)} msg1=${String(body.msg1)}`);
    c.ok = true;
    for (const [k, v] of Object.entries(body)) {
      if (Array.isArray(v)) {
        const a = v as Rec[];
        console.log(`  배열 ${k}: ${a.length}행${a.length ? `, 필드: ${Object.keys(a[0]).join(",")}` : ""}`);
        a.slice(0, SC_PROBE_HEAD_ROWS).forEach((r, i) => console.log(`    [${i}] ${short(r)}`));
        if (a.length > SC_PROBE_HEAD_ROWS) console.log(`    [끝] ${short(a[a.length - 1])}`);
        if (a.length > c.rows) { c.rows = a.length; c.arr = a; c.arrKey = k; c.fields = a.length ? Object.keys(a[0]).join(",") : ""; }
      } else if (v && typeof v === "object") console.log(`  객체 ${k}: ${short(v)}`);
    }
    const dk = c.arr?.length ? Object.keys(c.arr[0]).find((x) => /bsop_date|deal_date|stnd_date|date$|dt$/i.test(x)) : undefined;
    if (dk && c.arr) { const ds = c.arr.map((r) => String(r[dk])).filter(Boolean).sort(); c.first = ds[0]; c.last = ds[ds.length - 1]; }
  } catch (e) {
    c.err = `${kst()} KST ${e instanceof Error ? e.message.slice(0, 300) : String(e)}`;
    console.log(`  오류: ${c.err}`);
  }
  calls.push(c);
  return c;
}
const num = (v: unknown): number => { const n = Number(String(v ?? "").trim()); return Number.isFinite(n) ? n : NaN; };

async function main(): Promise<void> {
  console.log(`공매도·신용잔고 데이터 조사: ${new Date().toISOString()} (KST ${kst()}) | 외부 요청 상한 ${SC_PROBE_REQUEST_CAP}`);
  const shortP = (code: string, from: string, to: string): Record<string, string> => ({ FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: code, FID_INPUT_DATE_1: from, FID_INPUT_DATE_2: to });
  const creditP = (code: string, d: string): Record<string, string> => ({ FID_COND_MRKT_DIV_CODE: "J", FID_COND_SCR_DIV_CODE: "20476", FID_INPUT_ISCD: code, FID_INPUT_DATE_1: d });

  // ---- 2(B-2). KRX 후보 경로 ----
  console.log("\n=== KRX Open API 후보 경로 (기준일 2016-07-01) ===");
  const key = process.env.KRX_API_KEY;
  console.log("| 경로 | HTTP | respCode | respMsg | 행 수 |\n|---|---|---|---|---|");
  for (const p of SC_PROBE_KRX_PATHS) {
    if (!key || used() >= SC_PROBE_REQUEST_CAP) break;
    krxReq++; await sleep(SC_PROBE_KRX_GAP_MS);
    try {
      const r = await fetch(`https://data-dbg.krx.co.kr/svc/apis/${p}?basDd=${SC_PROBE_KRX_DATE}`, { headers: { AUTH_KEY: key } });
      const t = await r.text(); let j: Rec | null = null; try { j = JSON.parse(t); } catch { j = null; }
      console.log(`| ${p} | ${r.status} | ${String(j?.respCode ?? "-")} | ${String(j?.respMsg ?? "-").slice(0, 60)} | ${((j?.OutBlock_1 as unknown[]) ?? []).length} |`);
    } catch (e) { console.log(`| ${p} | fetch 실패 | - | ${e instanceof Error ? e.message.slice(0, 60) : "-"} | 0 |`); }
  }

  // ---- 1(B-1). KIS 005930 기준일별 ----
  console.log("\n=== KIS 005930: 공매도 일별추이(FHPST04830000)·신용잔고 일별추이(FHPST04760000) 기준일별 ===");
  const res = new Map<string, Call | null>();
  for (const a of SC_PROBE_ANCHORS) {
    const from = a === SC_PROBE_LATEST ? addDays(a, -SC_PROBE_SHORT_WINDOW_DAYS) : a, to = a === SC_PROBE_LATEST ? a : addDays(a, SC_PROBE_SHORT_WINDOW_DAYS);
    res.set(`공매도 ${a}`, await kis(`공매도 일별추이 ${SC_PROBE_STOCK} ${from}~${to}`, SHORT, "FHPST04830000", shortP(SC_PROBE_STOCK, from, to)));
    res.set(`신용 ${a}`, await kis(`신용잔고 일별추이 ${SC_PROBE_STOCK} 결제일 ${a}`, CREDIT, "FHPST04760000", creditP(SC_PROBE_STOCK, a)));
  }
  res.set("공매도 큰구간", await kis(`공매도 일별추이 ${SC_PROBE_STOCK} 20100104~${SC_PROBE_LATEST} (1회 최대 행 수 확인)`, SHORT, "FHPST04830000", shortP(SC_PROBE_STOCK, "20100104", SC_PROBE_LATEST)));
  // 더 이른 날짜: 2010-01-04에 응답이 있을 때만
  for (const [tr, key2] of [["공매도", "공매도 20100104"], ["신용", "신용 20100104"]] as const) {
    const c = res.get(key2);
    if (c && c.ok && c.rows > 0) for (const e of SC_PROBE_EARLIER) {
      if (tr === "공매도") res.set(`공매도 ${e}`, await kis(`공매도 일별추이 ${SC_PROBE_STOCK} ${e}~${addDays(e, SC_PROBE_SHORT_WINDOW_DAYS)}`, SHORT, "FHPST04830000", shortP(SC_PROBE_STOCK, e, addDays(e, SC_PROBE_SHORT_WINDOW_DAYS))));
      else res.set(`신용 ${e}`, await kis(`신용잔고 일별추이 ${SC_PROBE_STOCK} 결제일 ${e}`, CREDIT, "FHPST04760000", creditP(SC_PROBE_STOCK, e)));
    }
  }

  // ---- 폐지 종목·SMALL 1개 ----
  console.log("\n=== 상장폐지 종목·SMALL 종목 ===");
  const delA = SC_PROBE_DELISTED_ANCHOR;
  res.set(`폐지 공매도`, await kis(`공매도 일별추이 ${SC_PROBE_DELISTED} ${delA}~${addDays(delA, SC_PROBE_SHORT_WINDOW_DAYS)}`, SHORT, "FHPST04830000", shortP(SC_PROBE_DELISTED, delA, addDays(delA, SC_PROBE_SHORT_WINDOW_DAYS))));
  res.set(`폐지 신용`, await kis(`신용잔고 일별추이 ${SC_PROBE_DELISTED} 결제일 ${delA}`, CREDIT, "FHPST04760000", creditP(SC_PROBE_DELISTED, delA)));

  // ---- Parquet: SMALL 임의 1개 + 수집 규모 ----
  console.log("\n(Parquet 읽기: SMALL 종목 선정·수집 규모 계산)");
  const series = await loadAllStockSeriesFromParquet(2010, new Date().getUTCFullYear());
  interface Pr { code: string; dates: string[]; mcap: Float64Array; avgTv: Float64Array; raw: Float64Array }
  const prs: Pr[] = [];
  const calSet = new Set<string>();
  for (const [code, rows] of series) {
    for (const r of rows) calSet.add(r.tradeDate);
    prs.push({ code, dates: rows.map((r) => r.tradeDate), mcap: Float64Array.from(rows.map((r) => r.marketCapEok)), avgTv: computeTrailingAvgTradingValue(rows, PIT_LIQUIDITY_LOOKBACK_DAYS), raw: Float64Array.from(rows.map((r) => r.closePrice)) });
    series.delete(code);
  }
  prs.sort((a, b) => (a.code < b.code ? -1 : 1));
  const CAL = [...calSet].sort();
  const monthEnds = new Set<string>();
  for (let k = 0; k + 1 < CAL.length; k++) if (CAL[k].slice(0, 7) !== CAL[k + 1].slice(0, 7)) monthEnds.add(CAL[k]);
  const idxOf = prs.map((p) => new Map(p.dates.map((d, i) => [d, i])));
  const smallPick: string[] = [];
  for (let s = 0; s < prs.length; s++) {
    const i = idxOf[s].get(SC_PROBE_SMALL_PICK_DATE);
    if (i === undefined || i < 1) continue;
    const pm = prs[s].mcap[i - 1];
    if (pm >= SCAN_SMALL_MIN_MCAP_EOK && pm < SCAN_CAP_EOK && prs[s].avgTv[i] >= SCAN_SMALL_MIN_AVG_TV_WON && prs[s].raw[i] >= SCAN_SMALL_MIN_PRICE_WON) smallPick.push(prs[s].code);
  }
  const smallCode = smallPick[Math.floor(smallPick.length / 2)];
  console.log(`SMALL 구성원(${SC_PROBE_SMALL_PICK_DATE}) ${smallPick.length}종목 중 코드순 중앙값: ${smallCode}`);
  res.set("SMALL 공매도", await kis(`공매도 일별추이 ${smallCode}(SMALL) ${delA}~${addDays(delA, SC_PROBE_SHORT_WINDOW_DAYS)}`, SHORT, "FHPST04830000", shortP(smallCode, delA, addDays(delA, SC_PROBE_SHORT_WINDOW_DAYS))));
  res.set("SMALL 신용", await kis(`신용잔고 일별추이 ${smallCode}(SMALL) 결제일 ${delA}`, CREDIT, "FHPST04760000", creditP(smallCode, delA)));

  // ---- 3(B-3). 금지 기간 ----
  console.log("\n=== 금지 기간 확인 (005930 공매도 일별추이) ===");
  const banRes: { label: string; arr: Rec[] }[] = [];
  for (const w of SC_PROBE_BAN_WINDOWS) {
    const c = await kis(`공매도 일별추이 ${SC_PROBE_STOCK} ${w.from}~${w.to} (${w.label})`, SHORT, "FHPST04830000", shortP(SC_PROBE_STOCK, w.from, w.to));
    if (c?.arr) banRes.push({ label: w.label, arr: c.arr });
  }
  // 날짜·값 열 이름 탐색(공매도 체결 수량·거래대금)
  const sample = banRes[0]?.arr[0] ?? calls.find((c) => c.arr?.length && c.label.startsWith("공매도"))?.arr?.[0];
  if (sample) {
    const keys = Object.keys(sample);
    const dateK = keys.find((k) => /bsop_date|stnd_date|date/i.test(k)) ?? "";
    const volK = keys.find((k) => /^ssts_cntg_qty$/i.test(k)) ?? keys.find((k) => /ssts.*qty|ssts.*vol/i.test(k)) ?? "";
    const amtK = keys.find((k) => /^ssts_tr_pbmn$/i.test(k)) ?? keys.find((k) => /ssts.*pbmn/i.test(k)) ?? "";
    console.log(`\n금지 기간 분석에 쓴 필드: 날짜 ${dateK}, 공매도 수량 ${volK}, 공매도 거래대금 ${amtK}`);
    for (const { label, arr } of banRes) {
      const rows = arr.map((r) => ({ d: iso(String(r[dateK])), v: num(r[volK]), a: num(r[amtK]) })).sort((x, y) => (x.d < y.d ? -1 : 1));
      const inBan = (d: string): boolean => SC_BAN_PERIODS.some((p) => d >= p.from && d <= p.to);
      const ban = rows.filter((r) => inBan(r.d)), out = rows.filter((r) => !inBan(r.d));
      const firstPos = rows.find((r) => r.v > 0 || r.a > 0);
      console.log(`  [${label}] 응답 ${rows.length}행(${rows[0]?.d}~${rows[rows.length - 1]?.d}); 금지 구간 안 ${ban.length}행 중 수량>0 ${ban.filter((r) => r.v > 0).length}행·거래대금>0 ${ban.filter((r) => r.a > 0).length}행; 금지 구간 밖 ${out.length}행 중 수량>0 ${out.filter((r) => r.v > 0).length}행; 구간 내 처음 값>0인 날 ${firstPos?.d ?? "-"}`);
      console.log("    일별(날짜:수량/거래대금) " + rows.map((r) => `${r.d.slice(5)}:${r.v}/${r.a}`).join(" "));
    }
  }

  // ---- 4(B-4). 정리 표 입력 ----
  console.log("\n=== 호출 결과 요약 ===\n| 호출 | 성공 | 행 수 | 응답 최이른 | 응답 최늦은 | 필드 | 오류 |\n|---|---|---|---|---|---|---|");
  for (const c of calls) console.log(`| ${c.label} | ${c.ok ? "O" : "X"} | ${c.rows} | ${c.first ?? "-"} | ${c.last ?? "-"} | ${c.fields.slice(0, 160)} | ${c.err ?? ""} |`);

  // 수집 규모 계산(2010~2026 전체, 가격 행 기준): 대형 420(월말 시총 상위 150 이력), MID(적격 중 상위 100 제외), SMALL
  const topEver = new Set<string>(), midEver = new Set<string>(), smallEver = new Set<string>();
  for (const d of monthEnds) {
    const el: { s: number; mc: number }[] = [], all: { s: number; mc: number }[] = [];
    for (let s = 0; s < prs.length; s++) {
      const i = idxOf[s].get(d);
      if (i === undefined) continue;
      all.push({ s, mc: prs[s].mcap[i] });
      if (i < 1) continue;
      const pm = prs[s].mcap[i - 1];
      if (pm >= SCAN_CAP_EOK && prs[s].avgTv[i] >= PIT_MIN_AVG_TRADING_VALUE_WON) el.push({ s, mc: prs[s].mcap[i] });
      else if (pm >= SCAN_SMALL_MIN_MCAP_EOK && pm < SCAN_CAP_EOK && prs[s].avgTv[i] >= SCAN_SMALL_MIN_AVG_TV_WON && prs[s].raw[i] >= SCAN_SMALL_MIN_PRICE_WON) smallEver.add(prs[s].code);
    }
    all.sort((a, b) => b.mc - a.mc || (prs[a.s].code < prs[b.s].code ? -1 : 1));
    for (const x of all.slice(0, INVESTOR_FLOW_TOP_N)) topEver.add(prs[x.s].code);
    el.sort((a, b) => b.mc - a.mc || (prs[a.s].code < prs[b.s].code ? -1 : 1));
    for (const x of el.slice(SCAN_POOL_SIZE)) midEver.add(prs[x.s].code);
  }
  const rowsOf = (set: Set<string>): { n: number; days: number; days2: number[] } => { let days = 0; const d2: number[] = []; for (const p of prs) if (set.has(p.code)) { const n = p.dates.filter((d) => d >= "2010-01-04").length; days += n; d2.push(n); } return { n: set.size, days, days2: d2 }; };
  const groups = [["대형 420(월말 시총 상위 150 이력)", rowsOf(topEver)], ["MID 전체(월말 MID 구성원 이력, 2010~2026)", rowsOf(midEver)], ["SMALL 전체(월말 SMALL 구성원 이력, 2010~2026)", rowsOf(smallEver)]] as const;
  console.log("\n=== 수집 규모 입력 (Parquet 2010~2026 가격 행 기준, 종목의 2010-01-04 이후 전 거래일 = 상한) ===\n| 집합 | 종목 수 | 종목-일 행 수 |\n|---|---|---|");
  for (const [n, g] of groups) console.log(`| ${n} | ${g.n} | ${g.days} |`);
  const shortRows = Math.max(...calls.filter((c) => c.label.includes("20100104~20261016")).map((c) => c.rows), 0);
  const credRows = Math.max(...calls.filter((c) => c.label.startsWith("신용잔고") && c.label.includes(SC_PROBE_STOCK)).map((c) => c.rows), 0);
  console.log(`\n관측한 1회 최대 행 수: 공매도 일별추이 ${shortRows}행(큰 구간 요청), 신용잔고 일별추이 ${credRows}행(기준일 요청)`);
  console.log("| TR | 집합 | 가정 1회 행 수 | 예상 요청 | 예상 시간(0.6초/건, 시간) | 예상 시간(0.9초/건, 시간) | Parquet 예상 용량 MB (13.43 B/행, 종목-일 행 기준) |\n|---|---|---|---|---|---|---|");
  for (const [tr, R] of [["공매도 일별추이", shortRows], ["신용잔고 일별추이", credRows]] as const) {
    if (!(R > 0)) { console.log(`| ${tr} | - | 관측 없음 | - | - | - | - |`); continue; }
    for (const [n, g] of groups) {
      const req = g.days2.reduce((a, d) => a + Math.ceil(d / R), 0);
      console.log(`| ${tr} | ${n} | ${R} | ${req} | ${((req * SC_PROBE_SEC_PER_REQ[0]) / 3600).toFixed(1)} | ${((req * SC_PROBE_SEC_PER_REQ[1]) / 3600).toFixed(1)} | ${((g.days * SC_PROBE_PARQUET_BYTES_PER_ROW) / 1e6).toFixed(1)} |`);
    }
  }
  const exp = await supabaseAdmin.from("kis_tokens").select("expires_at").limit(1);
  const stats = getKisCallStats();
  console.log(`\n외부 요청: KRX ${krxReq} + KIS 시도 ${stats.total}(재시도 ${stats.retried}) = ${krxReq + stats.total} | 소요 ${((Date.now() - T0) / 1000).toFixed(1)}s | kis_tokens.expires_at ${String(exp.data?.[0]?.expires_at ?? "-")} | 쓴 행 0`);
}

main().catch((e) => { console.error("실패:", e instanceof Error ? e.message : e, `요청=${used()}`); process.exit(1); });
