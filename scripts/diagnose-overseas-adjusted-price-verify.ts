/**
 * [디스포저블 진단, 조사 끝나면 정리 PR로 제거] lib/kis.ts의 getOverseasDailyPrices가
 * 보내는 MODP=0을 1로 바꾸는 버그 수정(fix/overseas-adjusted-price-modp) 전, 애플
 * (AAPL) 외 분할 이력이 있는 미국 종목 1~2개를 추가로 실측해 MODP=1이 분할 이전
 * 구간까지 소급 조정된 연속값을 주는지, MODP=0이 원가를 그대로 주는지 재확인한다
 * (2026-09-29 재검증). 표본: 테슬라(TSLA, 2020-08-31 5:1 분할), 엔비디아(NVDA,
 * 2024-06-10 10:1 분할). 참고로 애플(AAPL, 2020-08-31 4:1 분할)도 다시 확인한다.
 *
 * DB에는 kis_tokens 토큰 캐시 외에 아무것도 쓰지 않는다(그마저도 이미 유효한
 * 토큰이 있으면 재사용만 하고 새로 발급하지 않는다). lib/kis.ts의 토큰 발급/락
 * 로직을 그대로 import할 수 없어 최소한만 재구현했다(이전 진단 스크립트
 * diagnose-kis-adjusted-price-option.ts, 이미 정리됨, 와 동일한 패턴).
 *
 * 실행: tsx --conditions=react-server scripts/diagnose-overseas-adjusted-price-verify.ts
 * 필요 환경변수: KIS_APP_KEY, KIS_APP_SECRET, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";

const KIS_BASE_URL = process.env.KIS_BASE_URL ?? "https://openapi.koreainvestment.com:9443";
const TOKEN_ROW_ID = "kis";
const TR_ID_OVERSEAS_CHART = "HHDFS76240000";

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

async function compareSplit(
  label: string,
  excd: string,
  symb: string,
  bymd: string,
  accessToken: string,
  appKey: string,
  appSecret: string
): Promise<void> {
  console.log(`\n=== ${label} (EXCD=${excd}, SYMB=${symb}, BYMD 기준일=${bymd}) ===`);
  const adj0 = await fetchOverseasChart(excd, symb, bymd, "0", accessToken, appKey, appSecret);
  if (adj0.ok) printOverseasRows("MODP=0", adj0.rows);
  else console.log(`  [MODP=0] 실패: ${adj0.msg}`);

  const adj1 = await fetchOverseasChart(excd, symb, bymd, "1", accessToken, appKey, appSecret);
  if (adj1.ok) printOverseasRows("MODP=1", adj1.rows);
  else console.log(`  [MODP=1] 실패: ${adj1.msg}`);
}

async function main(): Promise<void> {
  console.log(`해외 수정주가(MODP) 재검증 시작: ${new Date().toISOString()}`);
  const appKey = process.env.KIS_APP_KEY;
  const appSecret = process.env.KIS_APP_SECRET;
  if (!appKey || !appSecret) throw new Error("KIS_APP_KEY / KIS_APP_SECRET 환경 변수가 없습니다.");

  console.log("\n토큰 확보 중...");
  const accessToken = await getAccessTokenReuseOnly();

  // BYMD는 조회 종료 기준일(공란=오늘). 분할일이 그 구간에 포함되도록 분할일보다
  // 조금 뒤 날짜를 넘긴다.
  await compareSplit("애플(AAPL) 2020-08-31 4:1 분할", "NAS", "AAPL", "20200910", accessToken, appKey, appSecret);
  await compareSplit("테슬라(TSLA) 2020-08-31 5:1 분할", "NAS", "TSLA", "20200910", accessToken, appKey, appSecret);
  await compareSplit("엔비디아(NVDA) 2024-06-10 10:1 분할", "NAS", "NVDA", "20240620", accessToken, appKey, appSecret);

  console.log("\n완료");
}

main().catch((error) => {
  console.error("해외 수정주가(MODP) 재검증 중 오류:", error);
  process.exit(1);
});
