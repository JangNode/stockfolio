/**
 * (임시) 배당 이력 버그 진단 3차 — 캐싱된 KIS 토큰(kis_tokens 테이블, 프로덕션과
 * 공유)으로 직접 ksdinfo/dividend를 호출해, 신규 발급 토큰(2차 진단, 성공)과
 * 차이가 있는지 확인한다. kis_tokens 행의 만료 시각도 함께 찍는다. DB는 읽기만
 * 한다 — 확인 후 삭제 예정.
 *
 *   tsx --conditions=react-server scripts/verify-valuation-005930.ts
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";

const KIS_BASE_URL = process.env.KIS_BASE_URL ?? "https://openapi.koreainvestment.com:9443";

async function main(): Promise<void> {
  const appKey = process.env.KIS_APP_KEY;
  const appSecret = process.env.KIS_APP_SECRET;
  if (!appKey || !appSecret) throw new Error("KIS_APP_KEY / KIS_APP_SECRET 없음");

  const { data: tokenRow, error } = await supabaseAdmin
    .from("kis_tokens")
    .select("access_token, expires_at, updated_at")
    .eq("id", "kis")
    .maybeSingle();

  if (error) throw new Error(`kis_tokens 조회 실패: ${error.message}`);
  if (!tokenRow) {
    console.log("kis_tokens 행이 없습니다.");
    return;
  }

  const now = new Date();
  const expiresAt = new Date(tokenRow.expires_at);
  console.log(`지금: ${now.toISOString()}`);
  console.log(`캐싱된 토큰 만료 시각: ${tokenRow.expires_at} (${expiresAt.getTime() - now.getTime()}ms 남음)`);
  console.log(`캐싱된 토큰 마지막 갱신: ${tokenRow.updated_at}`);
  console.log(`캐싱된 토큰(앞 20자): ${tokenRow.access_token.slice(0, 20)}...`);

  const toDate = `${now.getFullYear()}1231`;
  const fromDate = `${now.getFullYear() - 5}0101`;

  const url = new URL("/uapi/domestic-stock/v1/ksdinfo/dividend", KIS_BASE_URL);
  url.searchParams.set("CTS", "");
  url.searchParams.set("GB1", "0");
  url.searchParams.set("F_DT", fromDate);
  url.searchParams.set("T_DT", toDate);
  url.searchParams.set("SHT_CD", "005930");
  url.searchParams.set("HIGH_GB", "");

  console.log(`\n=== 캐싱된 토큰으로 ksdinfo/dividend 호출 ===`);
  const res = await fetch(url, {
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${tokenRow.access_token}`,
      appkey: appKey,
      appsecret: appSecret,
      tr_id: "HHKDB669102C0",
      custtype: "P",
    },
  });

  console.log(`HTTP 상태: ${res.status}`);
  const body = await res.json();
  console.log(JSON.stringify(body, null, 2));

  // 비교용: 같은 캐싱된 토큰으로 이미 잘 되던 다른 엔드포인트(현재가 조회)도 같이
  // 호출해본다 — 토큰 자체가 무효라면 이것도 실패해야 한다.
  console.log(`\n=== 캐싱된 토큰으로 inquire-price(005930) 호출 (비교용) ===`);
  const priceUrl = new URL("/uapi/domestic-stock/v1/quotations/inquire-price", KIS_BASE_URL);
  priceUrl.searchParams.set("FID_COND_MRKT_DIV_CODE", "J");
  priceUrl.searchParams.set("FID_INPUT_ISCD", "005930");
  const priceRes = await fetch(priceUrl, {
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${tokenRow.access_token}`,
      appkey: appKey,
      appsecret: appSecret,
      tr_id: "FHKST01010100",
      custtype: "P",
    },
  });
  console.log(`HTTP 상태: ${priceRes.status}`);
  const priceBody = await priceRes.json();
  console.log(JSON.stringify({ rt_cd: priceBody.rt_cd, msg1: priceBody.msg1, stck_prpr: priceBody.output?.stck_prpr }, null, 2));
}

main().catch((error) => {
  console.error("확인 중 오류:", error);
  process.exit(1);
});
