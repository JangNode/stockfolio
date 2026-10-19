/**
 * [임시 조사 — 병합 금지, 백테스트 없음, DB 쓰기 0(KIS 토큰 저장은 기존 로직이 필요할 때만 — 전후 비교로 보고), 키 값 출력 금지]
 * 투자자별(외국인·기관·개인) 순매수 데이터 확보 가능성 조사. PHASE=A: KRX 후보 경로 + KIS 여러 TR + Parquet 행 수. PHASE=B: 장 마감 후 시간 제한 재확인(KIS 일별 2종).
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { kisGetForResearch, getKisCallStats } from "@/lib/kis";
import { loadAllStockSeriesFromParquet } from "@/lib/stockDailyPricesStorage";
import { loadAppliedAdjustments } from "@/lib/stockPriceAdjustmentsStorage";
import {
  INVESTOR_PROBE_REQUEST_CAP, INVESTOR_PROBE_KRX_GAP_MS, INVESTOR_PROBE_DATES, INVESTOR_PROBE_KRX_PATHS, INVESTOR_PROBE_STOCK, INVESTOR_PROBE_HEAD_ROWS,
  INVESTOR_PROBE_ROW_CHARS, INVESTOR_PROBE_BYTES_PER_ROW,
} from "@/lib/investorProbeConfig";

const T0 = Date.now();
const PHASE = process.env.PHASE === "B" ? "B" : "A";
let krxReq = 0;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const used = (): number => krxReq + getKisCallStats().total;
const short = (v: unknown): string => JSON.stringify(v).slice(0, INVESTOR_PROBE_ROW_CHARS);

function summarize(body: Record<string, unknown>): { rows: number; firstDate?: string; lastDate?: string } {
  console.log(`  최상위 키: ${Object.keys(body).join(", ")} | rt_cd=${String(body.rt_cd)} msg_cd=${String(body.msg_cd)} msg1=${String(body.msg1)}`);
  let main = { rows: 0 } as { rows: number; firstDate?: string; lastDate?: string };
  for (const [k, v] of Object.entries(body)) {
    if (Array.isArray(v)) {
      console.log(`  배열 ${k}: ${v.length}행${v.length ? `, 필드: ${Object.keys(v[0] as object).join(",")}` : ""}`);
      (v as Record<string, unknown>[]).slice(0, INVESTOR_PROBE_HEAD_ROWS).forEach((r, i) => console.log(`    [${i}] ${short(r)}`));
      if (v.length > INVESTOR_PROBE_HEAD_ROWS) console.log(`    [끝] ${short(v[v.length - 1])}`);
      const dk = v.length ? Object.keys(v[0] as object).find((x) => /bsop_date|stck_bsop|date|dt$/i.test(x)) : undefined;
      if (v.length > main.rows) main = { rows: v.length, firstDate: dk ? String((v[0] as Record<string, unknown>)[dk]) : undefined, lastDate: dk ? String((v[v.length - 1] as Record<string, unknown>)[dk]) : undefined };
    } else if (v && typeof v === "object") console.log(`  객체 ${k}: ${short(v)}`);
  }
  return main;
}

async function kis(label: string, path: string, trId: string, params: Record<string, string>): Promise<{ rows: number } | null> {
  if (used() >= INVESTOR_PROBE_REQUEST_CAP) { console.log(`\n[${label}] 요청 상한 도달 — 건너뜀`); return null; }
  console.log(`\n[KIS] ${label} (${trId} ${path.split("/").pop()}) 파라미터: ${JSON.stringify(params)}`);
  try { return summarize(await kisGetForResearch(path, trId, params)); }
  catch (e) { console.log(`  오류: ${e instanceof Error ? e.message.slice(0, 300) : String(e)}`); return null; }
}

async function tokenExpiry(): Promise<string> {
  const { data } = await supabaseAdmin.from("kis_tokens").select("expires_at").limit(1);
  return String(data?.[0]?.expires_at ?? "-");
}

async function main(): Promise<void> {
  console.log(`투자자별 매매 데이터 조사 PHASE=${PHASE}: ${new Date().toISOString()} (KST ${new Date(Date.now() + 9 * 3600e3).toISOString().slice(11, 16)})`);
  const exp0 = await tokenExpiry();
  const MKT = "/uapi/domestic-stock/v1/quotations/inquire-investor-daily-by-market";
  const STK = "/uapi/domestic-stock/v1/quotations/investor-trade-by-stock-daily";
  const mkt = (d1: string, d2: string): Record<string, string> => ({ FID_COND_MRKT_DIV_CODE: "U", FID_INPUT_ISCD: "0001", FID_INPUT_DATE_1: d1, FID_INPUT_ISCD_1: "KSP", FID_INPUT_DATE_2: d2, FID_INPUT_ISCD_2: "0001" });
  const stk = (d: string): Record<string, string> => ({ FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: INVESTOR_PROBE_STOCK, FID_INPUT_DATE_1: d, FID_ORG_ADJ_PRC: "", FID_ETC_CLS_CODE: "" });
  const res: Record<string, { rows: number } | null> = {};

  if (PHASE === "A") {
    // ---- 1. KRX ----
    console.log("\n=== 1. KRX Open API 후보 경로 (기준일 2026-10-16) ===");
    const key = process.env.KRX_API_KEY;
    if (!key) throw new Error("KRX_API_KEY 필요");
    console.log("| 경로 | HTTP | respCode | respMsg | 행 수 |\n|---|---|---|---|---|");
    for (const p of INVESTOR_PROBE_KRX_PATHS) {
      if (used() >= INVESTOR_PROBE_REQUEST_CAP) break;
      krxReq++; await sleep(INVESTOR_PROBE_KRX_GAP_MS);
      try {
        const r = await fetch(`https://data-dbg.krx.co.kr/svc/apis/${p}?basDd=20261016`, { headers: { AUTH_KEY: key } });
        const t = await r.text(); let j: Record<string, unknown> | null = null; try { j = JSON.parse(t); } catch { j = null; }
        console.log(`| ${p} | ${r.status} | ${String(j?.respCode ?? "-")} | ${String(j?.respMsg ?? "-").slice(0, 60)} | ${((j?.OutBlock_1 as unknown[]) ?? []).length} |`);
      } catch (e) { console.log(`| ${p} | fetch 실패 | - | ${e instanceof Error ? e.message.slice(0, 60) : "-"} | 0 |`); }
    }
    // ---- 2. KIS ----
    console.log("\n=== 2. KIS ===");
    for (const d of INVESTOR_PROBE_DATES) res[`시장별 일별 ${d}`] = await kis(`시장별 투자자매매동향(일별) KOSPI ${d}`, MKT, "FHPTJ04040000", mkt(d, d));
    res["시장별 일별 구간"] = await kis("시장별 투자자매매동향(일별) KOSPI 구간 20100104~20261016", MKT, "FHPTJ04040000", mkt("20100104", "20261016"));
    for (const d of INVESTOR_PROBE_DATES) res[`종목별 일별 ${d}`] = await kis(`종목별 투자자매매동향(일별) ${INVESTOR_PROBE_STOCK} ${d}`, STK, "FHPTJ04160001", stk(d));
    res["현재가 투자자"] = await kis(`주식현재가 투자자(inquire-investor) ${INVESTOR_PROBE_STOCK}`, "/uapi/domestic-stock/v1/quotations/inquire-investor", "FHKST01010900", { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: INVESTOR_PROBE_STOCK });
    res["추정가집계"] = await kis(`종목별 외국인·기관 추정가집계 ${INVESTOR_PROBE_STOCK}`, "/uapi/domestic-stock/v1/quotations/investor-trend-estimate", "HHPTJ04160200", { MKSC_SHRN_ISCD: INVESTOR_PROBE_STOCK });
    res["외국인기관 매매종목가집계"] = await kis("외국인·기관 매매종목가집계", "/uapi/domestic-stock/v1/quotations/foreign-institution-total", "FHPTJ04400000", { FID_COND_MRKT_DIV_CODE: "V", FID_COND_SCR_DIV_CODE: "16449", FID_INPUT_ISCD: "0000", FID_DIV_CLS_CODE: "0", FID_RANK_SORT_CLS_CODE: "0", FID_ETC_CLS_CODE: "0" });

    // ---- 3. 저장된 데이터 / 규모 ----
    console.log("\n=== 3. 이미 저장된 데이터 (Parquet 컬럼·규모) ===");
    const adjustments = await loadAppliedAdjustments();
    const series = await loadAllStockSeriesFromParquet(2010, new Date().getUTCFullYear(), adjustments);
    const first = [...series.values()][0]?.[0];
    console.log(`Parquet 행 필드(StockDailyPriceRow): ${first ? Object.keys(first).join(", ") : "-"}`);
    let stockDays = 0; const perStock: number[] = [];
    const dates = new Set<string>();
    for (const rows of series.values()) { stockDays += rows.length; perStock.push(rows.length); for (const r of rows) dates.add(r.tradeDate); }
    console.log(`Parquet 2010~: 종목 ${series.size}개, 종목-일 ${stockDays}행, 거래일 ${dates.size}일`);
    (globalThis as { __est?: unknown }).__est = { stocks: series.size, stockDays, tradingDays: dates.size, perStock };
  } else {
    console.log("\n=== 장 마감 후 재확인 (KIS 일별 2종) ===");
    for (const d of ["20100104", "20261016"]) res[`시장별 일별 ${d}`] = await kis(`시장별 투자자매매동향(일별) KOSPI ${d}`, MKT, "FHPTJ04040000", mkt(d, d));
    res["시장별 일별 구간"] = await kis("시장별 투자자매매동향(일별) KOSPI 구간 20100104~20261016", MKT, "FHPTJ04040000", mkt("20100104", "20261016"));
    for (const d of ["20100104", "20261016"]) res[`종목별 일별 ${d}`] = await kis(`종목별 투자자매매동향(일별) ${INVESTOR_PROBE_STOCK} ${d}`, STK, "FHPTJ04160001", stk(d));
  }

  // ---- 4. 추정 ----
  const stats = getKisCallStats();
  const secPerReq = (Date.now() - T0) / 1000 / Math.max(stats.total, 1);
  const est = (globalThis as { __est?: { stocks: number; stockDays: number; tradingDays: number; perStock: number[] } }).__est;
  console.log("\n=== 4. 추정 입력 (이 실행에서 관측한 행 수) ===");
  for (const [k, v] of Object.entries(res)) console.log(`  ${k}: ${v ? `${v.rows}행` : "오류/없음"}`);
  if (est) {
    console.log(`  거래일 ${est.tradingDays}일, 종목 ${est.stocks}개, 종목-일 ${est.stockDays}행, 요청당 평균 ${secPerReq.toFixed(2)}초(이 실행 관측, 토큰·DB 읽기 포함)`);
    for (const R of [1, 5, 30, 100]) {
      const marketReq = Math.ceil(est.tradingDays / R);
      const stockReq = est.perStock.reduce((a, n) => a + Math.ceil(n / R), 0);
      console.log(`  가정 요청당 ${R}행: 시장 ${marketReq}건(${(marketReq * 0.75 / 60).toFixed(1)}분, 0.75초/건 가정), 종목별 ${stockReq}건(${(stockReq * 0.75 / 3600).toFixed(1)}시간); 저장 용량 시장 ${(est.tradingDays * INVESTOR_PROBE_BYTES_PER_ROW / 1e6).toFixed(2)}MB, 종목별 ${(est.stockDays * INVESTOR_PROBE_BYTES_PER_ROW / 1e6).toFixed(0)}MB (행당 ${INVESTOR_PROBE_BYTES_PER_ROW}B 가정)`);
    }
  }
  const exp1 = await tokenExpiry();
  console.log(`\nkis_tokens.expires_at 전 ${exp0} → 후 ${exp1} (${exp0 === exp1 ? "변화 없음 = 토큰 저장 없음" : "변화 있음 = 기존 로직이 토큰을 새로 저장함"})`);
  console.log(`외부 요청: KRX ${krxReq} + KIS 시도 ${stats.total}(재시도 ${stats.retried}) = ${krxReq + stats.total} | 소요 ${((Date.now() - T0) / 1000).toFixed(1)}s | 백테스트 없음`);
}

main().catch((e) => { console.error("실패:", e instanceof Error ? e.message : e, `요청=${used()}`); process.exit(1); });
