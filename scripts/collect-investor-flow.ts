/**
 * [연구용] 투자자별 수급 1단계: (1) 시장 전체(KOSPI·KOSDAQ) 일별, (2) 종목별 시험 6종목 → 새 표 2개(investor_flow_market, investor_flow_stock_pilot).
 * KIS 호출은 kisGetForResearch만 사용(상한 INVESTOR_FLOW_REQUEST_CAP). 14:00~14:30 KST에는 호출하지 않고 기다린다. 백테스트 없음. 키 값 출력 금지.
 * 이어받기: 종목별은 저장된 최소 날짜 이전부터, 시장별은 저장된 최소 날짜 이전부터 계속한다(RESUME=1).
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getIndexPriceSeries } from "@/lib/betaPriceHistoryStorage";
import { kisGetForResearch, getKisCallStats } from "@/lib/kis";
import { loadAllStockSeriesFromParquet } from "@/lib/stockDailyPricesStorage";
import { loadAppliedAdjustments } from "@/lib/stockPriceAdjustmentsStorage";
import {
  INVESTOR_FLOW_REQUEST_CAP, INVESTOR_FLOW_MARKET_FROM, INVESTOR_FLOW_TO, INVESTOR_FLOW_MARKET_PAGE_ROWS, INVESTOR_FLOW_STOCK_PAGE_ROWS, INVESTOR_FLOW_STOCK_FROM,
  INVESTOR_FLOW_FIXED_STOCKS, INVESTOR_FLOW_DELISTED_PICK, INVESTOR_FLOW_TOP_N, INVESTOR_FLOW_ENDED_GRACE_DAYS, INVESTOR_FLOW_BLOCK_UTC_FROM_MIN,
  INVESTOR_FLOW_BLOCK_UTC_TO_MIN, INVESTOR_FLOW_UPSERT_BATCH, INVESTOR_FLOW_BYTES_PER_STOCK_ROW,
} from "@/lib/investorFlowConfig";

const T0 = Date.now();
const MS_DAY = 86_400_000;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const kst = (d = new Date()): string => new Date(d.getTime() + 9 * 3600e3).toISOString().slice(11, 19);
const iso = (d: string): string => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
const ymd = (d: string): string => d.replace(/-/g, "");
const num = (v: unknown): number | null => { const s = String(v ?? "").trim(); if (s === "") return null; const n = Number(s); return Number.isFinite(n) ? n : null; };
const prevDay = (d: string): string => new Date(Date.parse(d) - MS_DAY).toISOString().slice(0, 10);
const f2 = (x: number): string => (Number.isFinite(x) ? x.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "-");
const dbRead: Record<string, number> = {};
let dbWritten = 0;
let kisMs = 0;
const errors: { at: string; label: string; msg: string }[] = [];
const MKT = "/uapi/domestic-stock/v1/quotations/inquire-investor-daily-by-market";
const STK = "/uapi/domestic-stock/v1/quotations/investor-trade-by-stock-daily";
type Rec = Record<string, unknown>;

async function waitIfBlocked(): Promise<void> {
  for (;;) {
    const n = new Date(), m = n.getUTCHours() * 60 + n.getUTCMinutes();
    if (m >= INVESTOR_FLOW_BLOCK_UTC_FROM_MIN && m < INVESTOR_FLOW_BLOCK_UTC_TO_MIN) { console.log(`  [대기] KST ${kst()} — 14:00~14:30 호출 금지 시간대, 30초 후 재확인`); await sleep(30_000); } else return;
  }
}
async function call(label: string, path: string, trId: string, params: Record<string, string>): Promise<Rec | null> {
  if (getKisCallStats().total >= INVESTOR_FLOW_REQUEST_CAP) { console.log(`  [${label}] 요청 상한 도달`); return null; }
  await waitIfBlocked();
  const t = Date.now();
  try { const r = await kisGetForResearch(path, trId, params); kisMs += Date.now() - t; return r; }
  catch (e) { kisMs += Date.now() - t; const msg = e instanceof Error ? e.message.slice(0, 200) : String(e); errors.push({ at: kst(), label, msg }); console.log(`  [오류 KST ${kst()}] ${label}: ${msg}`); return null; }
}
async function upsert(table: string, rows: Rec[], onConflict: string): Promise<void> {
  for (let i = 0; i < rows.length; i += INVESTOR_FLOW_UPSERT_BATCH) {
    const { error } = await supabaseAdmin.from(table).upsert(rows.slice(i, i + INVESTOR_FLOW_UPSERT_BATCH), { onConflict });
    if (error) throw new Error(`${table} upsert 실패: ${error.message}`);
    dbWritten += Math.min(INVESTOR_FLOW_UPSERT_BATCH, rows.length - i);
  }
}
async function minDate(table: string, col: string, filter: [string, string]): Promise<string | null> {
  const { data, error } = await supabaseAdmin.from(table).select(col).eq(filter[0], filter[1]).order(col, { ascending: true }).limit(1);
  if (error) throw new Error(`${table} 최소 날짜 조회 실패: ${error.message}`);
  dbRead[`${table}(최소날짜)`] = (dbRead[`${table}(최소날짜)`] ?? 0) + 1;
  return data && data[0] ? String((data[0] as unknown as Rec)[col]) : null;
}

// ---------------- 1. 시장 전체 ----------------
interface MRow { market: string; trade_date: string; index_close: number | null; frgn_ntby_qty: number | null; orgn_ntby_qty: number | null; prsn_ntby_qty: number | null; frgn_ntby_amt: number | null; orgn_ntby_amt: number | null; prsn_ntby_amt: number | null; scrt_ntby_amt: number | null; ivtr_ntby_amt: number | null; pe_fund_ntby_amt: number | null; bank_ntby_amt: number | null; insu_ntby_amt: number | null; mrbn_ntby_amt: number | null; fund_ntby_amt: number | null; etc_orgt_ntby_amt: number | null; etc_ntby_amt: number | null; etc_corp_ntby_amt: number | null }
const mapM = (market: string, r: Rec): MRow => ({
  market, trade_date: iso(String(r.stck_bsop_date)), index_close: num(r.bstp_nmix_prpr),
  frgn_ntby_qty: num(r.frgn_ntby_qty), orgn_ntby_qty: num(r.orgn_ntby_qty), prsn_ntby_qty: num(r.prsn_ntby_qty),
  frgn_ntby_amt: num(r.frgn_ntby_tr_pbmn), orgn_ntby_amt: num(r.orgn_ntby_tr_pbmn), prsn_ntby_amt: num(r.prsn_ntby_tr_pbmn),
  scrt_ntby_amt: num(r.scrt_ntby_tr_pbmn), ivtr_ntby_amt: num(r.ivtr_ntby_tr_pbmn), pe_fund_ntby_amt: num(r.pe_fund_ntby_tr_pbmn), bank_ntby_amt: num(r.bank_ntby_tr_pbmn),
  insu_ntby_amt: num(r.insu_ntby_tr_pbmn), mrbn_ntby_amt: num(r.mrbn_ntby_tr_pbmn), fund_ntby_amt: num(r.fund_ntby_tr_pbmn), etc_orgt_ntby_amt: num(r.etc_orgt_ntby_tr_pbmn),
  etc_ntby_amt: num(r.etc_ntby_tr_pbmn), etc_corp_ntby_amt: num(r.etc_corp_ntby_tr_pbmn),
});
const mktParams = (market: string, anchor: string): Record<string, string> => (market === "KOSPI"
  ? { FID_COND_MRKT_DIV_CODE: "U", FID_INPUT_ISCD: "0001", FID_INPUT_DATE_1: anchor, FID_INPUT_ISCD_1: "KSP", FID_INPUT_DATE_2: anchor, FID_INPUT_ISCD_2: "0001" }
  : { FID_COND_MRKT_DIV_CODE: "U", FID_INPUT_ISCD: "1001", FID_INPUT_DATE_1: anchor, FID_INPUT_ISCD_1: "KSQ", FID_INPUT_DATE_2: anchor, FID_INPUT_ISCD_2: "1001" });

async function collectMarket(market: string, kospiFirstClose: number | null): Promise<MRow[] | null> {
  console.log(`\n--- 시장 ${market} ---`);
  // KOSDAQ 파라미터 확인: 1건 시험 요청(성공하고 KOSPI와 다른 지수값이어야 함)
  let anchor = ymd(INVESTOR_FLOW_TO);
  const saved = process.env.RESUME === "1" ? await minDate("investor_flow_market", "trade_date", ["market", market]) : null;
  if (saved) anchor = ymd(prevDay(saved));
  const rows = new Map<string, MRow>();
  let pages = 0;
  for (;;) {
    const body = await call(`시장 ${market} ${anchor}`, MKT, "FHPTJ04040000", mktParams(market, anchor));
    pages++;
    const out = (body?.output as Rec[] | undefined) ?? [];
    if (!body || out.length === 0) { console.log(`  ${market}: 응답 없음/오류(페이지 ${pages}, 앵커 ${anchor})`); return pages === 1 && rows.size === 0 ? null : [...rows.values()]; }
    if (market === "KOSDAQ" && pages === 1) {
      const c0 = num(out[0].bstp_nmix_prpr);
      if (kospiFirstClose !== null && c0 === kospiFirstClose) { console.log("  KOSDAQ 파라미터가 KOSPI와 같은 값을 반환 → KOSDAQ 포기"); return null; }
      console.log(`  KOSDAQ 파라미터 확인: 첫 행 ${String(out[0].stck_bsop_date)} 지수 ${c0}`);
    }
    const mapped = out.filter((r) => r.stck_bsop_date).map((r) => mapM(market, r));
    for (const m of mapped) if (m.trade_date >= INVESTOR_FLOW_MARKET_FROM && m.trade_date <= INVESTOR_FLOW_TO) rows.set(m.trade_date, m);
    const oldest = mapped.length ? mapped[mapped.length - 1].trade_date : null;
    const nextAnchor = oldest ? ymd(prevDay(oldest)) : null;
    await upsert("investor_flow_market", mapped.filter((m) => m.trade_date >= INVESTOR_FLOW_MARKET_FROM && m.trade_date <= INVESTOR_FLOW_TO) as unknown as Rec[], "market,trade_date");
    if (!oldest || oldest <= INVESTOR_FLOW_MARKET_FROM || out.length < INVESTOR_FLOW_MARKET_PAGE_ROWS || nextAnchor === anchor) break;
    anchor = nextAnchor!;
  }
  console.log(`  ${market}: 페이지 ${pages}, 수집 ${rows.size}행 (${[...rows.keys()].sort()[0]} ~ ${[...rows.keys()].sort().pop()})`);
  return [...rows.values()];
}

function pctl(sorted: number[], p: number): number { return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : NaN; }

async function validateMarket(market: string, rows: MRow[]): Promise<void> {
  console.log(`\n[검증] ${market}`);
  const dates = rows.map((r) => r.trade_date).sort();
  console.log(`  수집 ${rows.length}행 (${dates[0]} ~ ${dates[dates.length - 1]}), 중복 날짜 ${rows.length - new Set(dates).size}`);
  const idx = await getIndexPriceSeries(market as "KOSPI" | "KOSDAQ", "2008-01-01", "2099-12-31");
  dbRead[`beta_price_history(${market})`] = idx.length;
  const idxDates = new Set(idx.map((p) => p.tradeDate)), flowDates = new Set(dates);
  const lo = idx.length ? idx[0].tradeDate : "";
  const inRange = (d: string): boolean => d >= lo && d <= INVESTOR_FLOW_TO;
  const missing = [...idxDates].filter((d) => inRange(d) && !flowDates.has(d)), extra = dates.filter((d) => inRange(d) && !idxDates.has(d));
  console.log(`  지수 표(${market}) ${idx.length}일 (${lo} ~ ${idx.length ? idx[idx.length - 1].tradeDate : "-"}) 대조(${lo}~${INVESTOR_FLOW_TO}): 지수에 있고 수급에 없는 날 ${missing.length}${missing.length ? ` (예: ${missing.slice(0, 5).join(",")})` : ""}, 수급에만 있는 날 ${extra.length}${extra.length ? ` (예: ${extra.slice(0, 5).join(",")})` : ""}; 지수 표 이전 구간(${INVESTOR_FLOW_MARKET_FROM}~${prevDay(lo)}) 수급 행 ${dates.filter((d) => d < lo).length}`);
  const idxClose = new Map(idx.map((p) => [p.tradeDate, p.closePrice]));
  const diffs = rows.filter((r) => r.index_close !== null && idxClose.has(r.trade_date)).map((r) => Math.abs((r.index_close as number) / (idxClose.get(r.trade_date) as number) - 1));
  diffs.sort((a, b) => a - b);
  console.log(`  지수 종가 대조(같은 날 ${diffs.length}건): 상대 차이 중앙값 ${(pctl(diffs, 0.5) * 100).toFixed(4)}% 최대 ${(diffs[diffs.length - 1] * 100).toFixed(4)}%`);
  const stat = (name: string, f: (r: MRow) => number | null): void => {
    const v = rows.map(f).filter((x): x is number => x !== null).map(Math.abs).sort((a, b) => a - b);
    const mx = rows.reduce((b, r) => { const x = f(r); return x !== null && Math.abs(x) > b.v ? { v: Math.abs(x), d: r.trade_date } : b; }, { v: -1, d: "-" });
    console.log(`  ${name}: 날짜 ${v.length}개, |값| 중앙값 ${f2(pctl(v, 0.5))} 95분위 ${f2(pctl(v, 0.95))} 최대 ${f2(mx.v)} (${mx.d})`);
  };
  console.log("  순매수 금액 합(단위: KIS 원시값 *_ntby_tr_pbmn) 분포:");
  stat("외국인+기관+개인", (r) => (r.frgn_ntby_amt === null || r.orgn_ntby_amt === null || r.prsn_ntby_amt === null ? null : r.frgn_ntby_amt + r.orgn_ntby_amt + r.prsn_ntby_amt));
  stat("외국인+기관+개인+기타(etc)", (r) => (r.frgn_ntby_amt === null || r.orgn_ntby_amt === null || r.prsn_ntby_amt === null || r.etc_ntby_amt === null ? null : r.frgn_ntby_amt + r.orgn_ntby_amt + r.prsn_ntby_amt + r.etc_ntby_amt));
  stat("외국인+기관+개인+기타법인(etc_corp)", (r) => (r.frgn_ntby_amt === null || r.orgn_ntby_amt === null || r.prsn_ntby_amt === null || r.etc_corp_ntby_amt === null ? null : r.frgn_ntby_amt + r.orgn_ntby_amt + r.prsn_ntby_amt + r.etc_corp_ntby_amt));
  stat("참고: |외국인| 자체", (r) => r.frgn_ntby_amt);
  stat("기관 − 세부 8종 합", (r) => { const p = [r.scrt_ntby_amt, r.ivtr_ntby_amt, r.pe_fund_ntby_amt, r.bank_ntby_amt, r.insu_ntby_amt, r.mrbn_ntby_amt, r.fund_ntby_amt, r.etc_orgt_ntby_amt]; return r.orgn_ntby_amt === null || p.some((x) => x === null) ? null : r.orgn_ntby_amt - (p as number[]).reduce((a, b) => a + b, 0); });
  const nz = rows.filter((r) => (r.frgn_ntby_qty ?? 0) !== 0 || (r.orgn_ntby_qty ?? 0) !== 0 || (r.prsn_ntby_qty ?? 0) !== 0).map((r) => r.trade_date).sort()[0];
  console.log(`  외국인·기관·개인 수량이 하나라도 0이 아닌 첫 날짜: ${nz ?? "-"}; 세 값이 모두 0인 날 ${rows.filter((r) => (r.frgn_ntby_qty ?? 0) === 0 && (r.orgn_ntby_qty ?? 0) === 0 && (r.prsn_ntby_qty ?? 0) === 0).length}일`);
}

// ---------------- 2. 종목별 ----------------
interface StockResult { code: string; label: string; pages: number; rows: number; first: string | null; last: string | null; firstNonZero: string | null; errors: number }
async function collectStock(code: string, label: string, startAnchor: string): Promise<StockResult> {
  console.log(`\n--- 종목 ${code} (${label}) ---`);
  let anchor = ymd(startAnchor);
  const saved = process.env.RESUME === "1" ? await minDate("investor_flow_stock_pilot", "trade_date", ["stock_code", code]) : null;
  if (saved) anchor = ymd(prevDay(saved));
  const got = new Map<string, Rec>();
  let pages = 0, err = 0;
  for (;;) {
    const body = await call(`종목 ${code} ${anchor}`, STK, "FHPTJ04160001", { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: code, FID_INPUT_DATE_1: anchor, FID_ORG_ADJ_PRC: "", FID_ETC_CLS_CODE: "" });
    pages++;
    const out = (body?.output2 as Rec[] | undefined) ?? [];
    if (!body) { err++; break; }
    if (out.length === 0) { console.log(`  빈 응답(앵커 ${anchor}, 페이지 ${pages})`); break; }
    const mapped = out.filter((r) => r.stck_bsop_date).map((r) => ({
      stock_code: code, trade_date: iso(String(r.stck_bsop_date)), close_price: num(r.stck_clpr), volume: num(r.acml_vol), trading_value: num(r.acml_tr_pbmn),
      frgn_ntby_qty: num(r.frgn_ntby_qty), orgn_ntby_qty: num(r.orgn_ntby_qty), prsn_ntby_qty: num(r.prsn_ntby_qty),
      frgn_ntby_amt: num(r.frgn_ntby_tr_pbmn), orgn_ntby_amt: num(r.orgn_ntby_tr_pbmn), prsn_ntby_amt: num(r.prsn_ntby_tr_pbmn),
    }));
    const keep = mapped.filter((m) => m.trade_date >= INVESTOR_FLOW_STOCK_FROM);
    for (const m of keep) got.set(m.trade_date, m as unknown as Rec);
    await upsert("investor_flow_stock_pilot", keep as unknown as Rec[], "stock_code,trade_date");
    const oldest = mapped.length ? mapped[mapped.length - 1].trade_date : null;
    if (!oldest || oldest <= INVESTOR_FLOW_STOCK_FROM || out.length < INVESTOR_FLOW_STOCK_PAGE_ROWS) break;
    const next = ymd(prevDay(oldest));
    if (next === anchor) break;
    anchor = next;
    if (pages % 40 === 0) console.log(`  진행: ${pages}페이지, 최오래 ${oldest}, 요청 누적 ${getKisCallStats().total}, KST ${kst()}`);
  }
  const ds = [...got.keys()].sort();
  const nzd = ds.filter((d) => { const r = got.get(d)!; return (r.frgn_ntby_qty as number | null ?? 0) !== 0 || (r.orgn_ntby_qty as number | null ?? 0) !== 0 || (r.prsn_ntby_qty as number | null ?? 0) !== 0; });
  const res = { code, label, pages, rows: got.size, first: ds[0] ?? null, last: ds[ds.length - 1] ?? null, firstNonZero: nzd[0] ?? null, errors: err };
  console.log(`  ${code}: 페이지 ${pages}, 저장 ${res.rows}행 (${res.first} ~ ${res.last}), 0이 아닌 첫 날짜 ${res.firstNonZero}, 오류 ${err}`);
  return res;
}

async function main(): Promise<void> {
  console.log(`투자자별 수급 1단계 시작: ${new Date().toISOString()} (KST ${kst()}) | KIS 상한 ${INVESTOR_FLOW_REQUEST_CAP} | RESUME=${process.env.RESUME ?? "0"}`);

  // ---- Parquet: 시총 상위 150 풀, 상장폐지 종목 선정 ----
  const adjustments = await loadAppliedAdjustments();
  const series = await loadAllStockSeriesFromParquet(2010, new Date().getUTCFullYear(), adjustments);
  const calSet = new Set<string>(); let lastDate = "";
  for (const rows of series.values()) for (const r of rows) { if (r.tradeDate >= "2010-01-01") calSet.add(r.tradeDate); if (r.tradeDate > lastDate) lastDate = r.tradeDate; }
  const cal = [...calSet].sort();
  const monthEnd = new Set<string>();
  for (let k = 0; k + 1 < cal.length; k++) if (cal[k].slice(0, 7) !== cal[k + 1].slice(0, 7)) monthEnd.add(cal[k]);
  const mcapAt = new Map<string, { code: string; mc: number }[]>();
  const perStockDays = new Map<string, number>(), lastRow = new Map<string, string>();
  for (const [code, rows] of series) {
    let n = 0;
    for (const r of rows) { if (r.tradeDate < "2010-01-01") continue; n++; if (monthEnd.has(r.tradeDate)) { const a = mcapAt.get(r.tradeDate) ?? []; a.push({ code, mc: r.marketCapEok }); mcapAt.set(r.tradeDate, a); } lastRow.set(code, r.tradeDate); }
    perStockDays.set(code, n);
  }
  const monthsTop = new Map<string, number>(), everTop = new Set<string>();
  for (const [, arr] of mcapAt) { arr.sort((a, b) => b.mc - a.mc || (a.code < b.code ? -1 : 1)); for (const x of arr.slice(0, INVESTOR_FLOW_TOP_N)) { everTop.add(x.code); monthsTop.set(x.code, (monthsTop.get(x.code) ?? 0) + 1); } }
  const endedBefore = new Date(Date.parse(lastDate) - INVESTOR_FLOW_ENDED_GRACE_DAYS * MS_DAY).toISOString().slice(0, 10);
  const delisted = [...everTop].filter((c) => (lastRow.get(c) ?? "9999") < endedBefore).sort((a, b) => (monthsTop.get(b)! - monthsTop.get(a)!) || (a < b ? -1 : 1));
  const picked = delisted.slice(0, INVESTOR_FLOW_DELISTED_PICK);
  console.log(`\nParquet(2010~): 종목 ${series.size}개, 마지막 날 ${lastDate}, 월말 ${monthEnd.size}개`);
  console.log(`월말 PIT 시총 상위 ${INVESTOR_FLOW_TOP_N}에 한 번이라도 든 종목 ${everTop.size}개; 그중 상장폐지(마지막 행 < ${endedBefore}) ${delisted.length}개`);
  console.log("상장폐지 종목 선정 규칙: 상위 150 소속 월 수 많은 순(동률 코드 순) 상위 2개");
  console.log("| 코드 | 상위150 소속 월 수 | 마지막 행(폐지일 추정) | 2010~ 거래일 수 |\n|---|---|---|---|");
  for (const c of picked) console.log(`| ${c} | ${monthsTop.get(c)} | ${lastRow.get(c)} | ${perStockDays.get(c)} |`);
  const everArr = [...everTop];
  const estReq = everArr.reduce((a, c) => a + Math.ceil((perStockDays.get(c) ?? 0) / INVESTOR_FLOW_STOCK_PAGE_ROWS), 0);
  const estRows = everArr.reduce((a, c) => a + (perStockDays.get(c) ?? 0), 0);
  series.clear();

  // ---- 1. 시장 ----
  console.log("\n=== 1. 시장 전체 수집 ===");
  const kospi = await collectMarket("KOSPI", null);
  if (kospi && kospi.length) await validateMarket("KOSPI", kospi);
  const kospiFirst = kospi ? kospi.sort((a, b) => (a.trade_date < b.trade_date ? 1 : -1))[0]?.index_close ?? null : null;
  const kosdaq = await collectMarket("KOSDAQ", kospiFirst);
  if (kosdaq && kosdaq.length) await validateMarket("KOSDAQ", kosdaq); else console.log("\nKOSDAQ: 수집하지 않음(KOSPI만)");
  const mktReq = getKisCallStats().total;

  // ---- 2. 종목별 시험 ----
  console.log("\n=== 2. 종목별 시험 수집 ===");
  const results: StockResult[] = [];
  const t2 = Date.now(); const req2 = getKisCallStats().total;
  for (const c of INVESTOR_FLOW_FIXED_STOCKS) results.push(await collectStock(c, "고정", INVESTOR_FLOW_TO));
  for (const c of picked) results.push(await collectStock(c, `상장폐지(${lastRow.get(c)})`, lastRow.get(c)!));
  const pilotReq = getKisCallStats().total - req2;
  console.log("\n| 종목 | 구분 | 요청(페이지) | 저장 행 | 첫 날짜 | 마지막 날짜 | 0이 아닌 첫 날짜 | 오류 |\n|---|---|---|---|---|---|---|---|");
  for (const r of results) console.log(`| ${r.code} | ${r.label} | ${r.pages} | ${r.rows} | ${r.first ?? "-"} | ${r.last ?? "-"} | ${r.firstNonZero ?? "-"} | ${r.errors} |`);
  console.log(`\n종목별 시험: 요청 ${pilotReq}건, 평균 ${(pilotReq ? (Date.now() - t2) / pilotReq / 1000 : NaN).toFixed(2)}초/건(DB upsert 포함 벽시계), KIS 응답만 평균 ${(getKisCallStats().total ? kisMs / getKisCallStats().total / 1000 : NaN).toFixed(2)}초/건(전체 요청 기준)`);
  console.log(errors.length ? `오류 ${errors.length}건: ${errors.map((e) => `[KST ${e.at}] ${e.label}: ${e.msg}`).join(" | ")}` : "오류 응답 0건 (TIME LIMIT 포함)");

  // ---- 3. 추정 ----
  const stats = getKisCallStats();
  const secPerReq = pilotReq ? (Date.now() - t2) / pilotReq / 1000 : 1;
  console.log(`\n=== 3. 추정: 2010~ 월말 PIT 시총 상위 ${INVESTOR_FLOW_TOP_N} 한 번이라도 든 종목 전체 수집 ===`);
  console.log(`종목 ${everArr.length}개, 종목-일 ${estRows}행, 예상 요청 ${estReq}건(⌈거래일수÷${INVESTOR_FLOW_STOCK_PAGE_ROWS}⌉ 합), 예상 시간 ${(estReq * secPerReq / 3600).toFixed(1)}시간(시험 평균 ${secPerReq.toFixed(2)}초/건), 예상 용량 ${(estRows * INVESTOR_FLOW_BYTES_PER_STOCK_ROW / 1e6).toFixed(0)}MB(행당 ${INVESTOR_FLOW_BYTES_PER_STOCK_ROW}B 가정)`);
  console.log(`\nSupabase 저장(upsert 전송) ${dbWritten}행, 읽은 행 ${JSON.stringify(dbRead)} | KIS 요청 ${stats.total}건(시장 ${mktReq}, 종목 시험 ${pilotReq}, 재시도 ${stats.retried}) | 소요 ${((Date.now() - T0) / 1000).toFixed(1)}s | 백테스트 없음`);
}

main().catch((e) => { console.error("실패:", e instanceof Error ? e.message : e, `KIS=${getKisCallStats().total} 저장=${dbWritten}`); process.exit(1); });
