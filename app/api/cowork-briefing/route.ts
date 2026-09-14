import { timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { upsertMarketBriefing, deleteOldMarketBriefings } from "@/lib/marketBriefingStorage";

const RATE_LIMIT_WINDOW_HOURS = 24;
const RATE_LIMIT_MAX_CALLS = 10;

function isTokenValid(request: Request): boolean {
  const expected = process.env.COWORK_WEBHOOK_TOKEN;
  if (!expected) return false;

  const provided = request.headers.get("x-cowork-webhook-token");
  if (!provided) return false;

  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);
  if (expectedBuf.length !== providedBuf.length) return false;

  return timingSafeEqual(expectedBuf, providedBuf);
}

/**
 * Cowork가 매일 아침 만드는 시장 브리핑 JSON을 받아 저장하는 웹훅. 인증은
 * 전용 토큰 헤더 하나뿐이라 실패 사유를 구체적으로 노출하지 않는다(401만).
 */
export async function POST(request: Request) {
  if (!isTokenValid(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const since = new Date(Date.now() - RATE_LIMIT_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
  const { count, error: countError } = await supabaseAdmin
    .from("cowork_webhook_calls")
    .select("id", { count: "exact", head: true })
    .gt("called_at", since);

  if (countError) {
    return NextResponse.json({ error: "rate limit check failed" }, { status: 502 });
  }

  if ((count ?? 0) >= RATE_LIMIT_MAX_CALLS) {
    return NextResponse.json({ error: "rate limited" }, { status: 429 });
  }

  const { error: insertError } = await supabaseAdmin.from("cowork_webhook_calls").insert({});
  if (insertError) {
    return NextResponse.json({ error: "rate limit check failed" }, { status: 502 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const meta = (body as Record<string, unknown>).meta;
  const dateKst =
    typeof meta === "object" && meta !== null
      ? (meta as Record<string, unknown>).date_kst
      : undefined;

  if (typeof dateKst !== "string" || dateKst.trim() === "") {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  try {
    await upsertMarketBriefing(body);
  } catch {
    return NextResponse.json({ error: "save failed" }, { status: 400 });
  }

  // 오래된 브리핑 정리는 저장 성공 여부와 무관한 부가 작업이라, 실패해도 이번
  // 요청의 핵심 결과(저장 성공)에는 영향을 주지 않는다 — 로그만 남긴다.
  deleteOldMarketBriefings().catch((e) => {
    console.error("오래된 시장 브리핑 정리 실패:", e instanceof Error ? e.message : e);
  });

  return NextResponse.json({ ok: true });
}
