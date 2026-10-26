// 진단(읽기 전용, 임시): KRX 지수 API에 2026-10-16~10-23 코스피 종가가 이미 공표됐는지 확인한다(저장 없음, 호출 8회).
const URL_ = "https://data-dbg.krx.co.kr/svc/apis/idx/kospi_dd_trd";
const DAYS = ["2026-10-16", "2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"];

async function main(): Promise<void> {
  const apiKey = process.env.KRX_API_KEY;
  if (!apiKey) throw new Error("KRX_API_KEY가 없습니다.");
  console.log(`현재 UTC ${new Date().toISOString()}`);
  for (const d of DAYS) {
    await new Promise((r) => setTimeout(r, 400));
    const res = await fetch(`${URL_}?basDd=${d.replaceAll("-", "")}`, { headers: { AUTH_KEY: apiKey }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) { console.log(`${d}: HTTP ${res.status}`); continue; }
    const body = (await res.json()) as { OutBlock_1?: { IDX_NM: string; CLSPRC_IDX: string }[] };
    const row = (body.OutBlock_1 ?? []).find((r) => r.IDX_NM === "코스피");
    console.log(`${d}: ${row ? `코스피 종가 ${row.CLSPRC_IDX}` : "응답 없음(미공표 또는 휴장)"}`);
  }
}
main().catch((e) => { console.error("진단 실패:", e instanceof Error ? e.message : e); process.exit(1); });
