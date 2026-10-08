/** [임시 조사 — 병합 금지, 읽기 전용] KRX 지수 API(idx/kospi_dd_trd, kosdaq_dd_trd)가 2010-11~2015 구간을 내려주는지 소수 날짜만 확인한다(수집·저장 없음). */
const KRX_BASE_URL = "https://data-dbg.krx.co.kr/svc/apis/idx";
const DATES = ["20091230", "20100104", "20101101", "20101104", "20120102", "20150102", "20151230", "20160104"];
const EXACT = { kospi_dd_trd: "코스피", kosdaq_dd_trd: "코스닥" } as const;

async function main(): Promise<void> {
  const apiKey = process.env.KRX_API_KEY;
  if (!apiKey) throw new Error("KRX_API_KEY 없음");
  for (const [endpoint, name] of Object.entries(EXACT)) {
    for (const d of DATES) {
      await new Promise((r) => setTimeout(r, 400));
      try {
        const res = await fetch(`${KRX_BASE_URL}/${endpoint}?basDd=${d}`, { headers: { AUTH_KEY: apiKey } });
        if (!res.ok) { console.log(`${endpoint} ${d}: HTTP ${res.status}`); continue; }
        const body = (await res.json()) as { OutBlock_1?: { IDX_NM: string; CLSPRC_IDX: string }[] };
        const rows = body.OutBlock_1 ?? [];
        const m = rows.find((r) => r.IDX_NM === name);
        console.log(`${endpoint} ${d}: 행 ${rows.length}, ${name} 종가 ${m?.CLSPRC_IDX ?? "없음"}`);
      } catch (e) {
        console.log(`${endpoint} ${d}: 오류 ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
