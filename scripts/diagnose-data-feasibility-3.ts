/**
 * [임시 진단 — 병합 금지, 시험 아님(시험 번호 290 유지), 읽기 전용] 데이터 가용성 점검 3: 국제유가·원/달러 환율·미국 지수·국고채 금리 일별 이력의 후보 출처별 응답 형태와 과거 깊이를 확인한다.
 * 항목마다 시험 호출 1~2회(날짜 몇 개), 대량 수집·저장 없음(Supabase·Storage 쓰기 0, 응답은 요약만 출력). 공시(DART) 사용 없음. 키 값은 출력하지 않는다(요청 주소에 키가 들어가는 호출은 주소를 찍지 않는다).
 * KST 14:00~15:40에는 KIS·KRX를 호출하지 않는다(그 시간에는 해당 항목을 건너뛰고 표시). FRED·ECOS는 시간대 제한이 없다. 호출 사이 간격을 둔다. FEAS_ONLY=id1,id2 로 일부 항목만 다시 호출할 수 있다.
 * 출처: FRED(일별 유가·환율·지수, 연구 키 FRED_API_KEY), 한국은행 ECOS(일별 환율·국고채 금리, ECOS_API_KEY), KIS 해외지수·환율·해외선물(기존 연구 호출 경로), KRX Open API 채권지수(idx/bon_dd_trd). 오피넷(한국석유공사)은 키가 없어 호출하지 않는다.
 */
import { kisGetForResearch } from "@/lib/kis";

const KRX_BASE = "https://data-dbg.krx.co.kr/svc/apis";
const FRED_BASE = "https://api.stlouisfed.org/fred";
const ECOS_BASE = "https://ecos.bok.or.kr/api";
const SLEEP_MS = 800;
const OV = "/uapi/overseas-price/v1/quotations";
const OVF = "/uapi/overseas-futureoption/v1/quotations";

interface Probe { id: string; item: string; kind: "fred-info" | "fred-obs" | "ecos" | "kis" | "krx"; /** 요청 설명(키 없음) */ desc: string; args: Record<string, string> }
const PROBES: Probe[] = [
  // ---- 국제유가 ----
  { id: "O1", item: "WTI 일별(FRED DCOILWTICO) 시리즈 정보", kind: "fred-info", desc: "series DCOILWTICO", args: { series_id: "DCOILWTICO" } },
  { id: "O1b", item: "WTI 일별 2011-01 표본", kind: "fred-obs", desc: "observations DCOILWTICO 2011-01-03~2011-01-14", args: { series_id: "DCOILWTICO", observation_start: "2011-01-03", observation_end: "2011-01-14" } },
  { id: "O2", item: "브렌트 일별(FRED DCOILBRENTEU) 시리즈 정보", kind: "fred-info", desc: "series DCOILBRENTEU", args: { series_id: "DCOILBRENTEU" } },
  { id: "O3", item: "두바이유(FRED POILDUBUSDM, IMF 월평균) 시리즈 정보 — 일별 두바이유가 FRED에 있는지 확인", kind: "fred-info", desc: "series POILDUBUSDM", args: { series_id: "POILDUBUSDM" } },
  { id: "O4", item: "KIS 해외선물 WTI(CL) 일간 체결 — 해외선물 시세 권한·응답 형태 확인", kind: "kis", desc: `${OVF}/inquire-daily-ccnl TR HHDFC55020100 SRS_CD CLZ26`, args: { path: `${OVF}/inquire-daily-ccnl`, trId: "HHDFC55020100", SRS_CD: "CLZ26", EXCH_CD: "NYM", START_DATE_TIME: "", CLOSE_DATE_TIME: "20261105", QRY_TP: "Q", QRY_CNT: "30", QRY_GAP: "", INDEX_KEY: "" } },
  // ---- 원/달러 환율 ----
  { id: "E1", item: "원/달러 환율 일별(ECOS 731Y001 매매기준율 0000001), 2011-01 표본", kind: "ecos", desc: "StatisticSearch 731Y001 D 20110103~20110114 0000001", args: { stat: "731Y001", cycle: "D", from: "20110103", to: "20110114", item: "0000001" } },
  { id: "E1b", item: "원/달러 환율 일별(ECOS 731Y001), 2000-01 표본(과거 깊이)", kind: "ecos", desc: "StatisticSearch 731Y001 D 20000104~20000114 0000001", args: { stat: "731Y001", cycle: "D", from: "20000104", to: "20000114", item: "0000001" } },
  { id: "E2", item: "원/달러 환율 일별(FRED DEXKOUS, 원/달러 정오 매입율) 시리즈 정보", kind: "fred-info", desc: "series DEXKOUS", args: { series_id: "DEXKOUS" } },
  { id: "E3", item: "KIS 해외 환율 일봉(시장 X, 원/달러 후보 코드 FX@KRW), 2011-01", kind: "kis", desc: `${OV}/inquire-daily-chartprice TR FHKST03030100 시장 X 코드 FX@KRW`, args: { path: `${OV}/inquire-daily-chartprice`, trId: "FHKST03030100", FID_COND_MRKT_DIV_CODE: "X", FID_INPUT_ISCD: "FX@KRW", FID_INPUT_DATE_1: "20110103", FID_INPUT_DATE_2: "20110131", FID_PERIOD_DIV_CODE: "D" } },
  // ---- 미국 지수 ----
  { id: "U1", item: "S&P 500 일별 종가(FRED SP500) 시리즈 정보 — FRED 보관 기간 확인", kind: "fred-info", desc: "series SP500", args: { series_id: "SP500" } },
  { id: "U2", item: "나스닥 종합 일별 종가(FRED NASDAQCOM) 시리즈 정보", kind: "fred-info", desc: "series NASDAQCOM", args: { series_id: "NASDAQCOM" } },
  { id: "U3", item: "KIS 해외지수 일봉(시장 N, S&P 500 후보 코드 SPX), 2011-01", kind: "kis", desc: `${OV}/inquire-daily-chartprice TR FHKST03030100 시장 N 코드 SPX`, args: { path: `${OV}/inquire-daily-chartprice`, trId: "FHKST03030100", FID_COND_MRKT_DIV_CODE: "N", FID_INPUT_ISCD: "SPX", FID_INPUT_DATE_1: "20110103", FID_INPUT_DATE_2: "20110131", FID_PERIOD_DIV_CODE: "D" } },
  { id: "U4", item: "KIS 해외지수 일봉(시장 N, 나스닥 종합 후보 코드 COMP), 2011-01", kind: "kis", desc: `${OV}/inquire-daily-chartprice TR FHKST03030100 시장 N 코드 COMP`, args: { path: `${OV}/inquire-daily-chartprice`, trId: "FHKST03030100", FID_COND_MRKT_DIV_CODE: "N", FID_INPUT_ISCD: "COMP", FID_INPUT_DATE_1: "20110103", FID_INPUT_DATE_2: "20110131", FID_PERIOD_DIV_CODE: "D" } },
  // ---- 국고채 금리 ----
  { id: "B1", item: "국고채 3년 금리 일별(ECOS 817Y002 시장금리(일별) 010200000), 2011-01 표본", kind: "ecos", desc: "StatisticSearch 817Y002 D 20110103~20110114 010200000", args: { stat: "817Y002", cycle: "D", from: "20110103", to: "20110114", item: "010200000" } },
  { id: "B2", item: "국고채 10년 금리 일별(ECOS 817Y002 010210000), 2011-01 표본", kind: "ecos", desc: "StatisticSearch 817Y002 D 20110103~20110114 010210000", args: { stat: "817Y002", cycle: "D", from: "20110103", to: "20110114", item: "010210000" } },
  { id: "B3", item: "KRX 채권지수 일별(idx/bon_dd_trd), 2011-01-03", kind: "krx", desc: "idx/bon_dd_trd basDd=20110103", args: { endpoint: "idx/bon_dd_trd", basDd: "20110103" } },
  { id: "B3b", item: "KRX 채권지수 일별(idx/bon_dd_trd), 최근 20261104", kind: "krx", desc: "idx/bon_dd_trd basDd=20261104", args: { endpoint: "idx/bon_dd_trd", basDd: "20261104" } },
];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const trunc = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/** 응답의 배열·객체 필드를 요약한다(행 수, 필드 이름, 첫/끝 행). */
function summarize(body: Record<string, unknown>): string[] {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(body)) {
    if (["rt_cd", "msg_cd", "msg1"].includes(k)) continue;
    if (Array.isArray(v)) {
      const rows = v as Record<string, unknown>[];
      lines.push(`  ${k}: 배열 ${rows.length}행${rows.length ? `, 필드 ${Object.keys(rows[0]).join(",")}` : ""}`);
      if (rows.length) { lines.push(`    첫 행: ${trunc(JSON.stringify(rows[0]), 600)}`); if (rows.length > 1) lines.push(`    끝 행: ${trunc(JSON.stringify(rows[rows.length - 1]), 600)}`); }
    } else if (v && typeof v === "object") {
      lines.push(`  ${k}: 객체 필드 ${Object.keys(v as object).join(",")}`);
      lines.push(`    값: ${trunc(JSON.stringify(v), 700)}`);
    } else lines.push(`  ${k}: ${trunc(String(v), 120)}`);
  }
  return lines;
}

async function getJson(url: string): Promise<{ status: number; body: Record<string, unknown> | null; text: string }> {
  const res = await fetch(url);
  const text = await res.text();
  let body: Record<string, unknown> | null = null;
  try { body = JSON.parse(text) as Record<string, unknown>; } catch { /* 비 JSON */ }
  return { status: res.status, body, text };
}

async function main(): Promise<void> {
  const kst = new Date(Date.now() + 9 * 3600_000), hm = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  const blocked = hm >= 14 * 60 && hm < 15 * 60 + 40;
  console.log(`데이터 가용성 점검 3 시작: ${new Date().toISOString()} (KST ${String(kst.getUTCHours()).padStart(2, "0")}:${String(kst.getUTCMinutes()).padStart(2, "0")})${blocked ? " — KST 14:00~15:40이라 KIS·KRX 항목은 건너뜀" : ""}`);
  const only = (process.env.FEAS_ONLY ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const want = (id: string): boolean => only.length === 0 || only.includes("all") || only.includes(id);
  const fredKey = process.env.FRED_API_KEY, ecosKey = process.env.ECOS_API_KEY, krxKey = process.env.KRX_API_KEY;
  const n = { fred: 0, ecos: 0, kis: 0, krx: 0 };
  for (const p of PROBES.filter((x) => want(x.id))) {
    console.log(`\n### ${p.id} — ${p.item}\n  요청: ${p.desc}`);
    try {
      if (p.kind === "fred-info" || p.kind === "fred-obs") {
        if (!fredKey) { console.log("  결과: FRED_API_KEY 없음 — 호출 안 함"); continue; }
        n.fred++;
        const q = new URLSearchParams({ ...p.args, api_key: fredKey, file_type: "json" });
        const r = await getJson(`${FRED_BASE}/${p.kind === "fred-info" ? "series" : "series/observations"}?${q.toString()}`);
        console.log(`  결과: HTTP ${r.status}${r.body ? "" : `, 본문 ${trunc(r.text.replace(fredKey, "***"), 200)}`}`);
        if (r.body) {
          if (p.kind === "fred-info") {
            const s = ((r.body.seriess as Record<string, unknown>[] | undefined) ?? [])[0];
            if (s) console.log(`  제목 ${String(s.title)} | 주기 ${String(s.frequency)} | 단위 ${String(s.units)} | 관측 시작 ${String(s.observation_start)} ~ 끝 ${String(s.observation_end)} | 마지막 갱신 ${String(s.last_updated)}\n  메모: ${trunc(String(s.notes ?? ""), 400)}`);
            else for (const l of summarize(r.body)) console.log(l);
          } else {
            const o = (r.body.observations as Record<string, unknown>[] | undefined) ?? [];
            console.log(`  관측 ${o.length}개: ${o.slice(0, 6).map((x) => `${String(x.date)}=${String(x.value)}`).join(", ")}${o.length > 6 ? ` … ${String(o[o.length - 1].date)}=${String(o[o.length - 1].value)}` : ""}`);
          }
        }
      } else if (p.kind === "ecos") {
        if (!ecosKey) { console.log("  결과: ECOS_API_KEY 없음 — 호출 안 함"); continue; }
        n.ecos++;
        const a = p.args, r = await getJson(`${ECOS_BASE}/StatisticSearch/${ecosKey}/json/kr/1/10/${a.stat}/${a.cycle}/${a.from}/${a.to}/${a.item}`);
        console.log(`  결과: HTTP ${r.status}${r.body ? "" : `, 본문 ${trunc(r.text.replace(ecosKey, "***"), 200)}`}`);
        if (r.body) {
          const ss = r.body.StatisticSearch as { list_total_count?: number; row?: Record<string, unknown>[] } | undefined;
          if (ss) { const rows = ss.row ?? []; console.log(`  총 ${String(ss.list_total_count)}행(요청 구간), 받은 ${rows.length}행${rows.length ? `, 필드 ${Object.keys(rows[0]).join(",")}` : ""}`); for (const x of rows.slice(0, 3)) console.log(`    ${x.TIME} | ${x.STAT_NAME} | ${x.ITEM_NAME1} | ${x.DATA_VALUE} ${x.UNIT_NAME}`); }
          else console.log(`  응답: ${trunc(JSON.stringify(r.body), 400)}`);
        }
      } else if (p.kind === "kis") {
        if (blocked) { console.log("  결과: KST 14:00~15:40 — 호출하지 않음(재실행 필요)"); continue; }
        n.kis++;
        const { path, trId, ...params } = p.args;
        const body = await kisGetForResearch(path, trId, params, 1);
        console.log(`  결과: 성공 rt_cd=${String(body.rt_cd)} msg=${trunc(String(body.msg1 ?? ""), 100)}`);
        for (const l of summarize(body)) console.log(l);
      } else {
        if (blocked) { console.log("  결과: KST 14:00~15:40 — 호출하지 않음(재실행 필요)"); continue; }
        if (!krxKey) { console.log("  결과: KRX_API_KEY 없음 — 호출 안 함"); continue; }
        n.krx++;
        const res = await fetch(`${KRX_BASE}/${p.args.endpoint}?basDd=${p.args.basDd}`, { headers: { AUTH_KEY: krxKey } });
        const text = await res.text();
        let body: Record<string, unknown> | null = null;
        try { body = JSON.parse(text) as Record<string, unknown>; } catch { /* 비 JSON */ }
        console.log(`  결과: HTTP ${res.status}, ${(text.length / 1024).toFixed(1)} KiB${body ? "" : `, 본문 ${trunc(text, 200)}`}`);
        if (body) {
          for (const l of summarize(body)) console.log(l);
          const blk = Object.values(body).find((v) => Array.isArray(v)) as Record<string, unknown>[] | undefined;
          if (blk?.length) { const nm = blk.map((r) => String(r.IDX_NM ?? r.ISU_NM ?? "")); console.log(`  행 ${blk.length}개, 이름: ${trunc(nm.join(" | "), 900)}`); }
        }
      }
    } catch (e) {
      console.log(`  결과: 오류 ${trunc((e instanceof Error ? e.message : String(e)).replace(fredKey ?? "\u0000", "***").replace(ecosKey ?? "\u0000", "***"), 400)}`);
    }
    await sleep(SLEEP_MS);
  }
  console.log(`\n점검 종료: FRED ${n.fred}회, ECOS ${n.ecos}회, KIS ${n.kis}회, KRX ${n.krx}회 | Supabase 쓴 행 0(KIS 토큰은 운영 토큰 행을 읽고 만료 시에만 기존 경로로 갱신) | Storage 쓰기 0 | DART 호출 0 | 응답 저장 없음 | 오피넷 호출 없음(키 없음)`);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });
