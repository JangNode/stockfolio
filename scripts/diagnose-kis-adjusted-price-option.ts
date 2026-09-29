/**
 * [디스포저블 진단, 조사 끝나면 정리 PR로 제거] lib/kis.ts의 getDailyPrices(국내)/
 * getOverseasDailyPrices(해외)가 각각 FID_ORG_ADJ_PRC=0 / MODP=0("수정주가 미반영")을
 * 고정으로 보내는 이유가 코드에 남아있지 않아, 실제로 1(수정주가 반영)을 주면 값이
 * 달라지는지, 과거 전체 구간에 소급 적용되는지, 상장폐지 종목도 조회되는지를 소규모
 * 실측으로 확인한다(2026-09-29 조사). 삼성전자(005930, 2018-05-04 50:1 액면분할) +
 * 상장폐지 종목 1개 + 해외(애플, 2020-08-31 4:1 분할) 정도의 소규모 호출만 한다 —
 * 전종목 재조회 없음. DB에는 kis_tokens 토큰 캐시 외에 아무것도 쓰지 않는다(그마저도
 * 이미 유효한 토큰이 있으면 재사용만 하고 새로 발급하지 않는다 — 운영 중인 토큰을
 * 무효화하지 않기 위해서다. lib/kis.ts의 토큰 발급/락 로직을 그대로 import할 수
 * 없어 최소한만 재구현했다).
 *
 * 실행: tsx --conditions=react-server scripts/diagnose-kis-adjusted-price-option.ts
 * 필요 환경변수: KIS_APP_KEY, KIS_APP_SECRET, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getDailyPriceSeries, downloadYearPrices, type StockDailyPriceRow } from "@/lib/stockDailyPricesStorage";
import { getDelistedStockCodes } from "@/lib/delistedStockList";

const KIS_BASE_URL = process.env.KIS_BASE_URL ?? "https://openapi.koreainvestment.com:9443";
const TOKEN_ROW_ID = "kis";
const TR_ID_DOMESTIC_CHART = "FHKST03010100";
const TR_ID_OVERSEAS_CHART = "HHDFS76240000";

interface TokenRow {
  access_token: string;
  expires_at: string;
}

function isValid(row: TokenRow | null): row is TokenRow {
  if (!row) return false;
  return new Date(row.expires_at).getTime() - 60_000 > Date.now();
}

/** kis_tokens에 이미 유효한 토큰이 있으면 그대로 재사용하고, 없을 때만 새로
 * 발급해 저장한다(운영 코드의 원자적 락 없이 — 이 스크립트는 단발성 1회 실행이라
 * 동시성 충돌 가능성이 낮고, 만에 하나 겹쳐도 즉시 최신 토큰으로 덮어써 자가
 * 회복된다). */
async function getAccessTokenReuseOnly(): Promise<string> {
  const { data, error } = await supabaseAdmin.from("kis_tokens").select("access_token, expires_at").eq("id", TOKEN_ROW_ID).maybeSingle();
  if (error) throw new Error(`토큰 조회 실패: ${error.message}`);
  if (isValid(data as TokenRow | null)) {
    console.log("  (기존 유효 토큰 재사용 — 새로 발급하지 않음)");
    return (data as TokenRow).access_token;
  }

  console.log("  (유효 토큰 없음 — 신규 발급)");
  const appKey = process.env.KIS_APP_KEY;
  const appSecret = process.env.KIS_APP_SECRET;
  if (!appKey || !appSecret) throw new Error("KIS_APP_KEY / KIS_APP_SECRET 환경 변수가 없습니다.");

  const res = await fetch(`${KIS_BASE_URL}/oauth2/tokenP`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ grant_type: "client_credentials", appkey: appKey, appsecret: appSecret }),
  });
  if (!res.ok) throw new Error(`KIS 토큰 발급 실패 (${res.status}): ${await res.text()}`);
  const body: { access_token: string; expires_in: number } = await res.json();
  const expiresAt = new Date(Date.now() + body.expires_in * 1000);
  const { error: writeError } = await supabaseAdmin
    .from("kis_tokens")
    .upsert({ id: TOKEN_ROW_ID, access_token: body.access_token, expires_at: expiresAt.toISOString(), updated_at: new Date().toISOString(), issuing_until: null });
  if (writeError) throw new Error(`토큰 저장 실패: ${writeError.message}`);
  return body.access_token;
}

interface KisResponse {
  rt_cd: string;
  msg_cd: string;
  msg1: string;
}

async function kisFetch(url: URL, trId: string, accessToken: string, appKey: string, appSecret: string): Promise<KisResponse & Record<string, unknown>> {
  const res = await fetch(url, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      authorization: `Bearer ${accessToken}`,
      appkey: appKey,
      appsecret: appSecret,
      tr_id: trId,
      custtype: "P",
    },
    cache: "no-store",
  });
  const bodyText = await res.text();
  let body: (KisResponse & Record<string, unknown>) | null = null;
  try {
    body = JSON.parse(bodyText);
  } catch {
    // noop
  }
  return { rt_cd: body?.rt_cd ?? "HTTP_ERROR", msg_cd: body?.msg_cd ?? String(res.status), msg1: body?.msg1 ?? bodyText, ...(body ?? {}) };
}

interface DomesticChartRow {
  stck_bsop_date: string;
  stck_clpr: string;
  stck_oprc: string;
  acml_vol: string;
}

async function fetchDomesticChart(
  stockCode: string,
  dateFrom: string,
  dateTo: string,
  orgAdjPrc: "0" | "1",
  accessToken: string,
  appKey: string,
  appSecret: string
): Promise<{ ok: true; rows: DomesticChartRow[] } | { ok: false; msg: string }> {
  const url = new URL("/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice", KIS_BASE_URL);
  url.searchParams.set("FID_COND_MRKT_DIV_CODE", "J");
  url.searchParams.set("FID_INPUT_ISCD", stockCode);
  url.searchParams.set("FID_INPUT_DATE_1", dateFrom);
  url.searchParams.set("FID_INPUT_DATE_2", dateTo);
  url.searchParams.set("FID_PERIOD_DIV_CODE", "D");
  url.searchParams.set("FID_ORG_ADJ_PRC", orgAdjPrc);

  const body = await kisFetch(url, TR_ID_DOMESTIC_CHART, accessToken, appKey, appSecret);
  if (body.rt_cd !== "0") return { ok: false, msg: `${body.msg_cd}: ${body.msg1}` };
  const output2 = (body.output2 as DomesticChartRow[] | undefined) ?? [];
  return { ok: true, rows: output2.filter((r) => r.stck_bsop_date) };
}

function printDomesticRows(label: string, rows: DomesticChartRow[]): void {
  console.log(`  [${label}] ${rows.length}행`);
  for (const r of rows) {
    console.log(`    ${r.stck_bsop_date}: 종가=${Number(r.stck_clpr).toLocaleString()} 시가=${Number(r.stck_oprc).toLocaleString()} 거래량=${Number(r.acml_vol).toLocaleString()}`);
  }
}

interface OverseasChartRow {
  xymd: string;
  clos: string;
  open: string;
  tvol: string;
}

async function fetchOverseasChart(
  excd: string,
  symb: string,
  bymd: string,
  modp: "0" | "1",
  accessToken: string,
  appKey: string,
  appSecret: string
): Promise<{ ok: true; rows: OverseasChartRow[] } | { ok: false; msg: string }> {
  const url = new URL("/uapi/overseas-price/v1/quotations/dailyprice", KIS_BASE_URL);
  url.searchParams.set("AUTH", "");
  url.searchParams.set("EXCD", excd);
  url.searchParams.set("SYMB", symb);
  url.searchParams.set("GUBN", "0");
  url.searchParams.set("BYMD", bymd);
  url.searchParams.set("MODP", modp);

  const body = await kisFetch(url, TR_ID_OVERSEAS_CHART, accessToken, appKey, appSecret);
  if (body.rt_cd !== "0") return { ok: false, msg: `${body.msg_cd}: ${body.msg1}` };
  const output2 = (body.output2 as OverseasChartRow[] | undefined) ?? [];
  return { ok: true, rows: output2.filter((r) => r.xymd) };
}

function printOverseasRows(label: string, rows: OverseasChartRow[]): void {
  console.log(`  [${label}] ${rows.length}행`);
  for (const r of rows) {
    console.log(`    ${r.xymd}: 종가=${r.clos} 시가=${r.open} 거래량=${Number(r.tvol).toLocaleString()}`);
  }
}

/** 상장폐지 종목 중 저장된 시세가 있는(마지막 거래일을 알 수 있는) 종목 1개를
 * 고른다 — 존재하는 실제 종목코드 + 실제 마지막 거래일 근처로 KIS를 호출해봐야
 * "코드가 잘못됐나/원래 안 되나"를 구분할 수 있다. getDelistedStockCodes()의
 * 소스(GitHub raw CSV 미러)가 일시적으로 응답하지 않을 수 있어(2026-09-29
 * 1차 실행에서 실측 확인), 실패하면 대안으로 "예전 연도(2019~2021) Parquet엔
 * 있지만 최근 2년 hot 구간엔 없는 종목"을 상장폐지 근사 후보로 쓴다(둘 다 해당하면
 * 상장폐지가 아니라 그냥 백필 하한 미달로 최근에 저장 안 됐을 수도 있어 완벽하진
 * 않지만, "KIS가 이 코드를 아예 모르는지" 확인하는 목적엔 충분하다). */
async function pickDelistedSample(): Promise<{ code: string; lastDate: string } | null> {
  try {
    const delisted = await getDelistedStockCodes();
    const currentYear = new Date().getUTCFullYear();
    for (let year = currentYear; year >= currentYear - 5; year--) {
      const rows: StockDailyPriceRow[] = await downloadYearPrices(year);
      const candidates = rows.filter((r) => delisted.has(r.stockCode));
      if (candidates.length === 0) continue;
      candidates.sort((a, b) => b.tradeDate.localeCompare(a.tradeDate));
      return { code: candidates[0].stockCode, lastDate: candidates[0].tradeDate };
    }
  } catch (error) {
    console.log(`  getDelistedStockCodes() 실패, 대안 방식으로 전환: ${error instanceof Error ? error.message : String(error)}`);
  }

  const oldYearRows = await downloadYearPrices(2019);
  const recentCodes = new Set((await downloadYearPrices(new Date().getUTCFullYear() - 1)).map((r) => r.stockCode));
  const candidates = oldYearRows.filter((r) => !recentCodes.has(r.stockCode));
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.tradeDate.localeCompare(a.tradeDate));
  return { code: candidates[0].stockCode, lastDate: candidates[0].tradeDate };
}

function toYyyymmdd(dateStr: string): string {
  return dateStr.replaceAll("-", "");
}

function shiftDate(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  console.log(`KIS 수정주가 옵션 실측 시작: ${new Date().toISOString()}`);
  const appKey = process.env.KIS_APP_KEY;
  const appSecret = process.env.KIS_APP_SECRET;
  if (!appKey || !appSecret) throw new Error("KIS_APP_KEY / KIS_APP_SECRET 환경 변수가 없습니다.");

  console.log("\n토큰 확보 중...");
  const accessToken = await getAccessTokenReuseOnly();

  console.log("\n=== 1) 국내: 삼성전자(005930) 2018-05-04 50:1 액면분할 전후, FID_ORG_ADJ_PRC=0 vs 1 ===");
  const windows: { label: string; from: string; to: string }[] = [
    { label: "분할 직전후(2018-04~05)", from: "20180401", to: "20180531" },
    { label: "분할 훨씬 이전(2016-06~07, 소급 적용 여부 확인)", from: "20160601", to: "20160731" },
    { label: "최근(오늘 기준 최근 한 달)", from: toYyyymmdd(shiftDate(new Date().toISOString().slice(0, 10), -35)), to: toYyyymmdd(new Date().toISOString().slice(0, 10)) },
  ];

  for (const w of windows) {
    console.log(`\n-- ${w.label} (${w.from} ~ ${w.to}) --`);
    const adj0 = await fetchDomesticChart("005930", w.from, w.to, "0", accessToken, appKey, appSecret);
    if (adj0.ok) printDomesticRows("FID_ORG_ADJ_PRC=0", adj0.rows);
    else console.log(`  [FID_ORG_ADJ_PRC=0] 실패: ${adj0.msg}`);

    const adj1 = await fetchDomesticChart("005930", w.from, w.to, "1", accessToken, appKey, appSecret);
    if (adj1.ok) printDomesticRows("FID_ORG_ADJ_PRC=1", adj1.rows);
    else console.log(`  [FID_ORG_ADJ_PRC=1] 실패: ${adj1.msg}`);
  }

  console.log("\n=== 2) 국내: 상장폐지(근사) 종목 1개 조회 가능 여부(FID_ORG_ADJ_PRC=0) ===");
  try {
  const delistedSample = await pickDelistedSample();
  if (!delistedSample) {
    console.log("  저장된 시세가 있는 상장폐지 종목 표본을 찾지 못했습니다.");
  } else {
    console.log(`  표본: ${delistedSample.code} (저장 데이터상 마지막 거래일 ${delistedSample.lastDate})`);
    const from = toYyyymmdd(shiftDate(delistedSample.lastDate, -30));
    const to = toYyyymmdd(shiftDate(delistedSample.lastDate, 5));
    const res = await fetchDomesticChart(delistedSample.code, from, to, "0", accessToken, appKey, appSecret);
    if (res.ok) {
      console.log(`  조회 성공: ${res.rows.length}행`);
      printDomesticRows(`${delistedSample.code} 상장폐지 전후`, res.rows.slice(-10));
    } else {
      console.log(`  조회 실패(=KIS가 상장폐지 종목을 지원하지 않을 가능성): ${res.msg}`);
    }
    // 비교용으로 같은 종목의 저장된(KRX 기반) 값도 함께 보여준다.
    const stored = await getDailyPriceSeries(delistedSample.code, shiftDate(delistedSample.lastDate, -30), shiftDate(delistedSample.lastDate, 5));
    console.log(`  (참고) 저장된 KRX 기반 시세 ${stored.length}행 — 마지막 3행: ${stored.slice(-3).map((r) => `${r.tradeDate}:${r.closePrice}`).join(", ")}`);
  }
  } catch (error) {
    console.log(`  2번 섹션 실패(3번은 계속 진행): ${error instanceof Error ? error.message : String(error)}`);
  }

  console.log("\n=== 3) 해외 참고: 애플(AAPL, NAS) 2020-08-31 4:1 분할 전후, MODP=0 vs 1 ===");
  const overseasAdj0 = await fetchOverseasChart("NAS", "AAPL", "20200910", "0", accessToken, appKey, appSecret);
  if (overseasAdj0.ok) printOverseasRows("MODP=0", overseasAdj0.rows);
  else console.log(`  [MODP=0] 실패: ${overseasAdj0.msg}`);

  const overseasAdj1 = await fetchOverseasChart("NAS", "AAPL", "20200910", "1", accessToken, appKey, appSecret);
  if (overseasAdj1.ok) printOverseasRows("MODP=1", overseasAdj1.rows);
  else console.log(`  [MODP=1] 실패: ${overseasAdj1.msg}`);

  console.log("\n완료");
}

main().catch((error) => {
  console.error("KIS 수정주가 옵션 실측 중 오류:", error);
  process.exit(1);
});
