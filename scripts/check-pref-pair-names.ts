/**
 * [임시 연구 — 병합 금지] 연구 A 쌍 구성 점검: 코드 규칙으로 만든 우선주-보통주 쌍(187개)의 종목명을 KRX 일별매매정보(연말 거래일 + 최근 거래일)에서 받아 대조한다.
 * 읽기 전용(수익률·MDD 계산 없음). KRX Open API 요청만(연도 수 × 2시장, 상한 40건), DB·Storage 쓰기 0. 사전 등록: docs/research/a-pref-spread-prereg.md
 */
import { loadAllStockSeriesFromParquet } from "@/lib/stockDailyPricesStorage";
import { MM_KRX_BASE_URL, MM_ENDPOINTS, MM_REQUEST_GAP_MS, MM_RETRY_COUNT, MM_RETRY_DELAY_MS } from "@/lib/marketMembershipConfig";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const REQUEST_CAP = 40;
const norm = (s: string): string => s.replace(/\s+/g, "");
const PREF_SUFFIX = /\d*우(B|C)?(\(전환\))?$/;

async function main(): Promise<void> {
  const apiKey = process.env.KRX_API_KEY;
  if (!apiKey) throw new Error("KRX_API_KEY 환경 변수가 없습니다.");
  const hm = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date()).replace(":", ""));
  if (hm >= 1400 && hm < 1540) throw new Error(`KST ${hm} — 14:00~15:40에는 KRX·KIS 호출을 하지 않는다`);
  const series = await loadAllStockSeriesFromParquet(2010, new Date().getUTCFullYear());
  const calSet = new Set<string>();
  for (const rows of series.values()) for (const r of rows) if (r.tradeDate >= "2010-01-01") calSet.add(r.tradeDate);
  const CAL = [...calSet].sort();
  const prefCodes = [...series.keys()].filter((c) => c.length === 6 && c[5] !== "0").sort();
  const pairs = prefCodes.filter((p) => series.has(`${p.slice(0, 5)}0`)).map((p) => ({ pref: p, common: `${p.slice(0, 5)}0` }));
  const last = (code: string): string => { const r = series.get(code)!; return r[r.length - 1].tradeDate; };
  const first = (code: string): string => series.get(pairs.find((q) => q.pref === code)?.pref ?? code)![0].tradeDate;
  const meta = new Map(pairs.map((p) => [p.pref, { first: first(p.pref), last: last(p.pref), cLast: last(p.common) }]));
  series.clear();
  console.log(`쌍 ${pairs.length}개 (우선주 후보 ${prefCodes.length}개)`);

  // 표본 날짜: 매년 마지막 거래일 + 데이터 끝
  const dates: string[] = [];
  for (let y = 2010; y <= Number(CAL[CAL.length - 1].slice(0, 4)); y++) {
    const ds = CAL.filter((d) => d.startsWith(`${y}-`));
    if (ds.length) dates.push(ds[ds.length - 1]);
  }
  if (dates[dates.length - 1] !== CAL[CAL.length - 1]) dates.push(CAL[CAL.length - 1]);
  const namesOn = new Map<string, Map<string, string>>(); // 날짜 -> 코드 -> 종목명
  let requests = 0, fieldNote = false;
  for (const d of dates) {
    const m = new Map<string, string>();
    for (const [market, ep] of MM_ENDPOINTS) {
      let got: Record<string, string>[] | null = null;
      for (let a = 0; a <= MM_RETRY_COUNT && got === null; a++) {
        if (requests >= REQUEST_CAP) throw new Error("요청 상한");
        requests++;
        try {
          const res = await fetch(`${MM_KRX_BASE_URL}/${ep}?basDd=${d.replaceAll("-", "")}`, { headers: { AUTH_KEY: apiKey } });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          got = ((await res.json()) as { OutBlock_1?: Record<string, string>[] }).OutBlock_1 ?? [];
        } catch (e) { console.log(`  재시도 ${market} ${d}: ${e instanceof Error ? e.message : String(e)}`); await sleep(MM_RETRY_DELAY_MS); }
      }
      await sleep(MM_REQUEST_GAP_MS);
      if (got === null) { console.log(`  실패 ${market} ${d}`); continue; }
      if (!fieldNote && got.length) { console.log(`응답 필드 예: ${Object.keys(got[0]).join(", ")}`); fieldNote = true; }
      for (const r of got) {
        const code = r.ISU_SRT_CD && r.ISU_SRT_CD.length === 6 ? r.ISU_SRT_CD : r.ISU_CD && r.ISU_CD.length === 12 ? r.ISU_CD.slice(3, 9) : r.ISU_CD;
        const name = r.ISU_NM ?? r.ISU_ABBRV;
        if (code && name) m.set(code, name);
      }
    }
    namesOn.set(d, m);
  }
  console.log(`KRX 요청 ${requests}건, 표본 날짜 ${dates.length}개(${dates[0]}~${dates[dates.length - 1]})`);

  const exact: string[] = [], loose: string[] = [], bad: string[] = [], unver: string[] = [];
  for (const p of pairs) {
    let pn: string | undefined, cn: string | undefined;
    for (const d of dates) {
      const m = namesOn.get(d)!;
      if (m.has(p.pref) && m.has(p.common)) { pn = m.get(p.pref); cn = m.get(p.common); }
    }
    if (pn === undefined || cn === undefined) { unver.push(`${p.pref}/${p.common}`); continue; }
    const base = norm(pn).replace(PREF_SUFFIX, ""), c = norm(cn);
    if (norm(pn) !== base && base === c) exact.push(`${p.pref} ${pn} ↔ ${p.common} ${cn}`);
    else if (norm(pn) !== base && (c.startsWith(base) || base.startsWith(c))) loose.push(`${p.pref} ${pn} ↔ ${p.common} ${cn}`);
    else bad.push(`${p.pref} ${pn} ↔ ${p.common} ${cn}`);
  }
  console.log(`\n=== 종목명 대조 결과 ===\n일치(우선주명에서 '우' 접미를 떼면 보통주명과 같음) ${exact.length}쌍 | 부분 일치(한쪽이 다른 쪽으로 시작: 사명 변경 등) ${loose.length}쌍 | 불일치 ${bad.length}쌍 | 확인 불가(표본 날짜에 두 종목이 같은 날 목록에 없음) ${unver.length}쌍`);
  if (loose.length) console.log(`\n부분 일치 목록:\n${loose.join("\n")}`);
  if (bad.length) console.log(`\n불일치 목록:\n${bad.join("\n")}`);
  if (unver.length) console.log(`\n확인 불가 목록(코드): ${unver.map((u) => { const pc = u.split("/")[0]; const mt = meta.get(pc); return `${u}[우선주 ${mt?.first}~${mt?.last}]`; }).join(", ")}`);
  console.log("\n=== 실행 지표 ===\nSupabase 쓴 행: 0 | Storage 쓰기 0 | 수익률 계산 없음");
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });
