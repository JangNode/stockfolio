/**
 * (임시) 배당 이력 빈 응답 버그 5차 진단 — 005930 기준. 4차 진단에서 12회 연속
 * 호출 전부 "output 개수=-1"(Array.isArray(body.output)===false)로 나와, 이번엔
 * raw JSON 응답 전체를 그대로 찍어서 output이 정확히 어떤 값(undefined/null/
 * 빈 객체 등)으로 오는지 확인한다. DB는 읽기만 한다 — 확인 후 삭제 예정.
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
    .select("access_token")
    .eq("id", "kis")
    .maybeSingle();
  if (error || !tokenRow) throw new Error(`kis_tokens 조회 실패: ${error?.message ?? "행 없음"}`);

  const now = new Date();
  const toDate = `${now.getFullYear()}1231`;
  const fromDate = `${now.getFullYear() - 5}0101`;
  console.log(`지금(UTC): ${now.toISOString()}`);

  const url = new URL("/uapi/domestic-stock/v1/ksdinfo/dividend", KIS_BASE_URL);
  url.searchParams.set("CTS", "");
  url.searchParams.set("GB1", "0");
  url.searchParams.set("F_DT", fromDate);
  url.searchParams.set("T_DT", toDate);
  url.searchParams.set("SHT_CD", "005930");
  url.searchParams.set("HIGH_GB", "");
  console.log(`요청 URL: ${url.toString()}`);

  for (let i = 1; i <= 3; i++) {
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
    const text = await res.text();
    console.log(`\n=== 시도 ${i}: HTTP ${res.status} ===`);
    console.log(`typeof output 확인 전 raw text 길이: ${text.length}`);
    console.log(text);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

main().catch((error) => {
  console.error("확인 중 오류:", error);
  process.exit(1);
});
