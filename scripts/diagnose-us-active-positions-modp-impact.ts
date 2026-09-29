/**
 * [디스포저블 진단, 조사 끝나면 정리 PR로 제거] getOverseasDailyPrices의 MODP=0→1
 * 버그 수정이 이미 저장된 데이터에 영향을 주는지 확인한다(2026-09-29). screening_results
 * (market='US', status='active')와 paper_positions(market='US')의 진입일 이후
 * 분할/병합 이력이 있는 종목이 있는지, KIS API를 낮은 레벨에서 직접 호출해(MODP=0 vs 1)
 * 진입일 종가가 서로 다른지로 판별한다(다르면 = 그 구간에 분할/병합이 있었다는 뜻).
 * DB는 읽기만 하고 아무것도 쓰지 않는다(kis_tokens 토큰 캐시 재사용/신규 발급 제외).
 *
 * 실행: tsx --conditions=react-server scripts/diagnose-us-active-positions-modp-impact.ts
 * 필요 환경변수: KIS_APP_KEY, KIS_APP_SECRET, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";

const KIS_BASE_URL = process.env.KIS_BASE_URL ?? "https://openapi.koreainvestment.com:9443";
const TOKEN_ROW_ID = "kis";
const TR_ID_OVERSEAS_CHART = "HHDFS76240000";
// 진입일 이후 최대 몇 건(영업일)까지 거슬러 조회할지. 페이지당 최대 100건 가정,
// 이 조사 대상 포지션은 전부 2026-08 이후 진입이라 3페이지(최대 300영업일)면 충분하다.
const MAX_PAGES = 3;

interface TokenRow {
  access_token: string;
  expires_at: string;
}

function isValid(row: TokenRow | null): row is TokenRow {
  if (!row) return false;
  return new Date(row.expires_at).getTime() - 60_000 > Date.now();
}

async function getAccessTokenReuseOnly(): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from("kis_tokens")
    .select("access_token, expires_at")
    .eq("id", TOKEN_ROW_ID)
    .maybeSingle();
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

async function kisFetch(
  url: URL,
  trId: string,
  accessToken: string,
  appKey: string,
  appSecret: string
): Promise<KisResponse & Record<string, unknown>> {
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

interface OverseasChartRow {
  xymd: string;
  clos: string;
}

function addDaysToYyyymmdd(yyyymmdd: string, days: number): string {
  const d = new Date(
    Number(yyyymmdd.slice(0, 4)),
    Number(yyyymmdd.slice(4, 6)) - 1,
    Number(yyyymmdd.slice(6, 8))
  );
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

/** entryDate(YYYY-MM-DD) 이후 오늘까지 전체 구간을 모아 entryDate에 가장 가까운(같거나
 * 이후 첫) 거래일 종가를 반환한다. */
async function fetchCloseNearDate(
  excd: string,
  symb: string,
  entryDate: string,
  modp: "0" | "1",
  accessToken: string,
  appKey: string,
  appSecret: string
): Promise<{ date: string; close: number } | null> {
  const entryYyyymmdd = entryDate.replaceAll("-", "");
  const collected: OverseasChartRow[] = [];
  let bymd = "";
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL("/uapi/overseas-price/v1/quotations/dailyprice", KIS_BASE_URL);
    url.searchParams.set("AUTH", "");
    url.searchParams.set("EXCD", excd);
    url.searchParams.set("SYMB", symb);
    url.searchParams.set("GUBN", "0");
    url.searchParams.set("BYMD", bymd);
    url.searchParams.set("MODP", modp);

    const body = await kisFetch(url, TR_ID_OVERSEAS_CHART, accessToken, appKey, appSecret);
    if (body.rt_cd !== "0") {
      console.log(`    (조회 실패 ${excd}/${symb} MODP=${modp}: ${body.msg_cd}: ${body.msg1})`);
      break;
    }
    const rows = ((body.output2 as OverseasChartRow[] | undefined) ?? []).filter((r) => r.xymd);
    if (rows.length === 0) break;
    collected.push(...rows);
    const oldest = rows[rows.length - 1].xymd;
    if (oldest <= entryYyyymmdd) break;
    bymd = addDaysToYyyymmdd(oldest, -1);
  }

  // xymd 오름차순으로 정렬 후 entryYyyymmdd 이상인 첫 행(진입일 또는 그 직후 거래일).
  collected.sort((a, b) => a.xymd.localeCompare(b.xymd));
  const match = collected.find((r) => r.xymd >= entryYyyymmdd);
  if (!match) return null;
  return { date: match.xymd, close: Number(match.clos) };
}

interface ActiveUsRow {
  source: "screening_results" | "paper_positions";
  stockCode: string;
  exchange: string | null;
  entryDate: string;
  storedEntryPrice: number;
}

async function loadActiveUsRows(): Promise<ActiveUsRow[]> {
  const rows: ActiveUsRow[] = [];

  const { data: screeningRows, error: screeningError } = await supabaseAdmin
    .from("screening_results")
    .select("stock_code, exchange, entry_price, matched_at")
    .eq("market", "US")
    .eq("status", "active");
  if (screeningError) throw new Error(`screening_results 조회 실패: ${screeningError.message}`);
  for (const r of screeningRows ?? []) {
    rows.push({
      source: "screening_results",
      stockCode: r.stock_code as string,
      exchange: r.exchange as string | null,
      entryDate: (r.matched_at as string).slice(0, 10),
      storedEntryPrice: Number(r.entry_price),
    });
  }

  const { data: paperRows, error: paperError } = await supabaseAdmin
    .from("paper_positions")
    .select("stock_code, exchange, avg_price, opened_at")
    .eq("market", "US");
  if (paperError) throw new Error(`paper_positions 조회 실패: ${paperError.message}`);
  for (const r of paperRows ?? []) {
    rows.push({
      source: "paper_positions",
      stockCode: r.stock_code as string,
      exchange: r.exchange as string | null,
      entryDate: (r.opened_at as string).slice(0, 10),
      storedEntryPrice: Number(r.avg_price),
    });
  }

  return rows;
}

async function main(): Promise<void> {
  console.log(`미국 활성 포지션 MODP 영향 조사 시작: ${new Date().toISOString()}`);
  const appKey = process.env.KIS_APP_KEY;
  const appSecret = process.env.KIS_APP_SECRET;
  if (!appKey || !appSecret) throw new Error("KIS_APP_KEY / KIS_APP_SECRET 환경 변수가 없습니다.");

  const rows = await loadActiveUsRows();
  console.log(`\nscreening_results(market=US, status=active) + paper_positions(market=US) 합계: ${rows.length}건`);
  if (rows.length === 0) {
    console.log("대상 행이 없습니다. 조사 종료.");
    return;
  }

  console.log("\n토큰 확보 중...");
  const accessToken = await getAccessTokenReuseOnly();

  for (const row of rows) {
    console.log(`\n=== [${row.source}] ${row.stockCode} (EXCD=${row.exchange ?? "?"}) 진입일=${row.entryDate} 저장된 진입가=${row.storedEntryPrice} ===`);
    if (!row.exchange) {
      console.log("  exchange 값이 없어 KIS 재조회 불가 — 건너뜀");
      continue;
    }
    const adj0 = await fetchCloseNearDate(row.exchange, row.stockCode, row.entryDate, "0", accessToken, appKey, appSecret);
    const adj1 = await fetchCloseNearDate(row.exchange, row.stockCode, row.entryDate, "1", accessToken, appKey, appSecret);
    if (!adj0 || !adj1) {
      console.log(`  진입일 근처 데이터를 찾지 못함 (MODP=0: ${adj0 ? "찾음" : "없음"}, MODP=1: ${adj1 ? "찾음" : "없음"})`);
      continue;
    }
    console.log(`  MODP=0(원가) ${adj0.date}: ${adj0.close}`);
    console.log(`  MODP=1(수정주가) ${adj1.date}: ${adj1.close}`);
    const diffPct = adj0.close !== 0 ? Math.abs(adj0.close - adj1.close) / adj0.close * 100 : 0;
    if (diffPct > 0.5) {
      console.log(`  ⚠ 영향 있음: 진입일 이후 분할/병합 추정(원가/수정주가 ${diffPct.toFixed(1)}% 차이)`);
    } else {
      console.log(`  영향 없음: 진입일 이후 분할/병합 없음(차이 ${diffPct.toFixed(2)}%)`);
    }
  }

  console.log("\n완료");
}

main().catch((error) => {
  console.error("미국 활성 포지션 MODP 영향 조사 중 오류:", error);
  process.exit(1);
});
