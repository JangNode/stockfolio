/**
 * (임시) 배당 이력 빈 응답 버그 4차 진단 — 005930 기준. PR #110에서 넣은 재시도
 * (최대 2회, 800ms 간격)로도 라이브 화면에서 여전히 "-"/0회/이력 없음이 나온다는
 * 사용자 보고를 재현·분석한다. 캐싱된 토큰으로 같은 쿼리를 8번 연속 호출해
 * (호출 사이 대기시간을 다르게 줘가며) 매번 성공/실패를 기록하고, 5개년 대신
 * 더 좁은 기간(최근 1년)으로도 시도해 기간 폭이 영향을 주는지 확인한다.
 * DB는 읽기만 한다 — 확인 후 삭제 예정.
 *
 *   tsx --conditions=react-server scripts/verify-valuation-005930.ts
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";

const KIS_BASE_URL = process.env.KIS_BASE_URL ?? "https://openapi.koreainvestment.com:9443";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callDividend(
  accessToken: string,
  appKey: string,
  appSecret: string,
  fDt: string,
  tDt: string
): Promise<{ status: number; rt_cd?: string; msg_cd?: string; msg1?: string; count: number }> {
  const url = new URL("/uapi/domestic-stock/v1/ksdinfo/dividend", KIS_BASE_URL);
  url.searchParams.set("CTS", "");
  url.searchParams.set("GB1", "0");
  url.searchParams.set("F_DT", fDt);
  url.searchParams.set("T_DT", tDt);
  url.searchParams.set("SHT_CD", "005930");
  url.searchParams.set("HIGH_GB", "");

  const res = await fetch(url, {
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
      appkey: appKey,
      appsecret: appSecret,
      tr_id: "HHKDB669102C0",
      custtype: "P",
    },
  });

  const body = await res.json();
  return {
    status: res.status,
    rt_cd: body.rt_cd,
    msg_cd: body.msg_cd,
    msg1: body.msg1,
    count: Array.isArray(body.output) ? body.output.length : -1,
  };
}

async function main(): Promise<void> {
  const appKey = process.env.KIS_APP_KEY;
  const appSecret = process.env.KIS_APP_SECRET;
  if (!appKey || !appSecret) throw new Error("KIS_APP_KEY / KIS_APP_SECRET 없음");

  const { data: tokenRow, error } = await supabaseAdmin
    .from("kis_tokens")
    .select("access_token, expires_at")
    .eq("id", "kis")
    .maybeSingle();
  if (error || !tokenRow) throw new Error(`kis_tokens 조회 실패: ${error?.message ?? "행 없음"}`);

  const now = new Date();
  console.log(`지금: ${now.toISOString()}, 토큰 만료: ${tokenRow.expires_at}`);

  const toDate5y = `${now.getFullYear()}1231`;
  const fromDate5y = `${now.getFullYear() - 5}0101`;
  const toDate1y = `${now.getFullYear()}1231`;
  const fromDate1y = `${now.getFullYear() - 1}0101`;

  console.log(`\n=== 5개년 범위(${fromDate5y}~${toDate5y})로 8회 연속 호출 (호출 간 1초 대기) ===`);
  for (let i = 1; i <= 8; i++) {
    const r = await callDividend(tokenRow.access_token, appKey, appSecret, fromDate5y, toDate5y);
    console.log(`  시도 ${i}: HTTP ${r.status}, rt_cd=${r.rt_cd}, msg_cd=${r.msg_cd}, msg1=${r.msg1}, output 개수=${r.count}`);
    await sleep(1000);
  }

  console.log(`\n=== 1개년 범위(${fromDate1y}~${toDate1y})로 4회 연속 호출 (호출 간 1초 대기) ===`);
  for (let i = 1; i <= 4; i++) {
    const r = await callDividend(tokenRow.access_token, appKey, appSecret, fromDate1y, toDate1y);
    console.log(`  시도 ${i}: HTTP ${r.status}, rt_cd=${r.rt_cd}, msg_cd=${r.msg_cd}, msg1=${r.msg1}, output 개수=${r.count}`);
    await sleep(1000);
  }
}

main().catch((error) => {
  console.error("확인 중 오류:", error);
  process.exit(1);
});
