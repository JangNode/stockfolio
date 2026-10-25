/**
 * [임시 확인 — 정리 대상, DB 쓰기 0] /api/market-regime 라우트를 서버 프로세스 안에서 직접 호출해 (A) 인증 게이트, (B) 데이터 경로를 확인한다.
 * (B)는 승인된 사용자를 흉내 내려고 이 프로세스 안에서만 supabaseAdmin.auth.getUser와 profiles 조회를 가짜로 바꾼다(운영 코드 변경 없음).
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { GET } from "@/app/api/market-regime/route";

async function call(token: string | null): Promise<{ status: number; body: unknown }> {
  const res = await GET(new Request("http://localhost/api/market-regime", { headers: token ? { authorization: `Bearer ${token}` } : {} }));
  return { status: res.status, body: await res.json() };
}

async function run(): Promise<void> {
  const noToken = await call(null);
  console.log(`A1 토큰 없음 → ${noToken.status} ${JSON.stringify(noToken.body)}`);
  const bogus = await call("not-a-real-token");
  console.log(`A2 가짜 토큰(실제 Supabase Auth 확인) → ${bogus.status} ${JSON.stringify(bogus.body)}`);

  // (B) 승인된 사용자 흉내: 이 프로세스 안에서만.
  const auth = supabaseAdmin.auth as unknown as { getUser: (t: string) => Promise<unknown> };
  auth.getUser = async () => ({ data: { user: { id: "diagnose-approved-user" } }, error: null });
  const realFrom = supabaseAdmin.from.bind(supabaseAdmin);
  (supabaseAdmin as unknown as { from: (t: string) => unknown }).from = (table: string) =>
    table === "profiles" ? { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { status: "approved" }, error: null }) }) }) } : realFrom(table);
  const ok = await call("fake-token");
  console.log(`B 승인 사용자(모의) → ${ok.status}`);
  const b = ok.body as { latest: Record<string, unknown> | null; timeline: unknown[]; stats: Record<string, unknown>; backfillThrough: string | null; dailyFrom: string | null; thresholds: unknown; status: unknown; error?: string };
  if (ok.status !== 200) { console.log(JSON.stringify(b)); return; }
  console.log(`latest=${JSON.stringify(b.latest)}\n타임라인 ${b.timeline.length}일(${(b.timeline[0] as { date: string }).date}~${(b.timeline[b.timeline.length - 1] as { date: string }).date}) | backfillThrough=${b.backfillThrough} dailyFrom=${b.dailyFrom}\nstats=${JSON.stringify(b.stats)}\nstatus=${JSON.stringify(b.status)}`);
  console.log(`API_RESPONSE_JSON_BEGIN\n${JSON.stringify(ok.body)}\nAPI_RESPONSE_JSON_END`);
}
run().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });
