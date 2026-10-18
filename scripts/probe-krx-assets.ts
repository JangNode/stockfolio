/**
 * [임시 점검 — 병합 금지, 읽기 전용, 저장 없음] 자산 배분용 데이터(ETF·채권지수·금시장) KRX Open API 확보 가능성.
 * KRX 요청 총 40건 이하(AUTH_KEY = 기존 KRX_API_KEY, 키 값 출력 금지). DART·KIS·DB 사용 없음. 숫자와 표만 출력한다.
 */
const T0 = Date.now();
const BASE = "https://data-dbg.krx.co.kr/svc/apis";
const REQUEST_CAP = 40;
let requests = 0;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Resp { http: number | string; code: string; msg: string; rows: Record<string, string>[]; rawHead: string }
async function krx(path: string, basDd: string, key: string): Promise<Resp> {
  if (requests >= REQUEST_CAP) return { http: "-", code: "-", msg: "요청 상한", rows: [], rawHead: "" };
  requests++;
  await sleep(300);
  try {
    const res = await fetch(`${BASE}/${path}?basDd=${basDd}`, { headers: { AUTH_KEY: key } });
    const text = await res.text();
    let j: Record<string, unknown> | null = null;
    try { j = JSON.parse(text) as Record<string, unknown>; } catch { j = null; }
    const rows = (j?.OutBlock_1 as Record<string, string>[] | undefined) ?? [];
    return { http: res.status, code: String(j?.respCode ?? "-"), msg: String(j?.respMsg ?? "-"), rows, rawHead: text.slice(0, 160).replace(/\s+/g, " ") };
  } catch (e) {
    return { http: "fetch 실패", code: "-", msg: e instanceof Error ? e.message : String(e), rows: [], rawHead: "" };
  }
}
const nameOf = (r: Record<string, string>): string => r.ISU_NM ?? r.IDX_NM ?? "";
const codeOf = (r: Record<string, string>): string => r.ISU_SRT_CD ?? r.ISU_CD ?? "";

async function main(): Promise<void> {
  const key = process.env.KRX_API_KEY;
  if (!key) throw new Error("KRX_API_KEY 환경변수가 필요합니다.");
  console.log(`KRX 자산 배분용 데이터 점검 시작(읽기 전용): ${new Date().toISOString()} | 요청 상한 ${REQUEST_CAP}`);
  const ETF_DATES = ["20100104", "20120102", "20150102", "20200102", "20261008"];
  const GOLD_DATES = ["20140401", "20200102", "20261008"];
  const WANT = ["069500", "114260", "148070", "153130", "132030", "261240"];
  const KW = ["국고채", "골드", "달러", "단기"];

  // ---- 1·2. ETF ----
  console.log("\n=== 1. ETF 일별매매정보 (etp/etf_bydd_trd) ===");
  console.log("| 날짜 | HTTP | respCode | respMsg | 행 수 |\n|---|---|---|---|---|");
  const etf: Record<string, Resp> = {};
  for (const d of ETF_DATES) { etf[d] = await krx("etp/etf_bydd_trd", d, key); const r = etf[d]; console.log(`| ${d} | ${r.http} | ${r.code} | ${r.msg} | ${r.rows.length} |`); }
  for (const d of ETF_DATES) if (etf[d].rows.length === 0 && etf[d].rawHead) console.log(`  (${d} 응답 앞부분: ${etf[d].rawHead})`);
  const withRows = ETF_DATES.filter((d) => etf[d].rows.length);
  if (withRows.length) {
    console.log(`\n필드명(${withRows[0]} 응답 기준, ${Object.keys(etf[withRows[0]].rows[0]).length}개): ${Object.keys(etf[withRows[0]].rows[0]).join(", ")}`);
    console.log(`예시 1행(${withRows[0]}): ${JSON.stringify(etf[withRows[0]].rows[0]).slice(0, 600)}`);
    const fieldSets = new Set(withRows.map((d) => Object.keys(etf[d].rows[0]).join(",")));
    console.log(`날짜별 필드 구성이 서로 다른 종류 수: ${fieldSets.size}`);
  }
  console.log("\n=== 2. 지정 종목 종가·NAV ===");
  console.log("| 종목코드 | 날짜 | 있음 | 종목명 | 종가 | NAV | 거래량 | 시가총액 | 기초지수 |\n|---|---|---|---|---|---|---|---|---|");
  for (const code of WANT) for (const d of ETF_DATES) {
    const rows = etf[d].rows;
    if (!rows.length) { console.log(`| ${code} | ${d} | (응답 행 없음) | - | - | - | - | - | - |`); continue; }
    const r = rows.find((x) => codeOf(x) === code || (x.ISU_CD ?? "").includes(code));
    console.log(r ? `| ${code} | ${d} | O | ${nameOf(r)} | ${r.TDD_CLSPRC ?? "-"} | ${r.NAV ?? "-"} | ${r.ACC_TRDVOL ?? "-"} | ${r.MKTCAP ?? "-"} | ${r.IDX_IND_NM ?? "-"} |` : `| ${code} | ${d} | X | - | - | - | - | - | - |`);
  }
  console.log("\n이름에 '국고채'·'골드'·'달러'·'단기'가 들어간 종목 (조회한 5개 날짜 중 처음 등장한 날짜 = 상장일 상한 추정, 날짜 간격이 넓어 정확한 상장일 아님)");
  console.log("| 키워드 | 코드 | 종목명 | 처음 보인 날짜 | 마지막 날짜 응답에서의 종가 | NAV |\n|---|---|---|---|---|---|");
  const seen = new Map<string, { name: string; first: string; kw: string[]; lastClose: string; lastNav: string }>();
  for (const d of ETF_DATES) for (const r of etf[d].rows) {
    const nm = nameOf(r), kws = KW.filter((k) => nm.includes(k));
    if (!kws.length) continue;
    const c = codeOf(r);
    const prev = seen.get(c);
    seen.set(c, { name: nm, first: prev?.first ?? d, kw: kws, lastClose: r.TDD_CLSPRC ?? "-", lastNav: r.NAV ?? "-" });
  }
  for (const [c, v] of [...seen.entries()].sort((a, b) => (a[1].first < b[1].first ? -1 : a[1].first > b[1].first ? 1 : a[0] < b[0] ? -1 : 1))) console.log(`| ${v.kw.join("·")} | ${c} | ${v.name} | ${v.first} | ${v.lastClose} | ${v.lastNav} |`);
  console.log("\n날짜별 ETF 행 수와 키워드 종목 수:");
  for (const d of ETF_DATES) console.log(`  ${d}: 전체 ${etf[d].rows.length}행, 키워드 해당 ${etf[d].rows.filter((r) => KW.some((k) => nameOf(r).includes(k))).length}행`);

  // ---- 5. 분배금·조정가격 필드 ----
  console.log("\n=== 5. 분배금·조정 가격 필드 ===");
  const allFields = new Set<string>();
  for (const d of withRows) for (const k of Object.keys(etf[d].rows[0])) allFields.add(k);
  const divLike = [...allFields].filter((k) => /DIV|DIST|분배|배당|ADJ|조정|PAY/i.test(k));
  console.log(`ETF 응답 필드 중 분배금·배당·조정 가격으로 보이는 이름: ${divLike.length ? divLike.join(", ") : "없음"}`);

  // ---- 3. 채권지수 ----
  console.log("\n=== 3. 채권지수 (idx/bon_dd_trd) ===");
  console.log("| 날짜 | HTTP | respCode | respMsg | 행 수 |\n|---|---|---|---|---|");
  const bon: Record<string, Resp> = {};
  for (const d of ETF_DATES) { bon[d] = await krx("idx/bon_dd_trd", d, key); const r = bon[d]; console.log(`| ${d} | ${r.http} | ${r.code} | ${r.msg} | ${r.rows.length} |`); }
  for (const d of ETF_DATES) if (bon[d].rows.length === 0 && bon[d].rawHead) console.log(`  (${d} 응답 앞부분: ${bon[d].rawHead})`);
  const bonRows = ETF_DATES.filter((d) => bon[d].rows.length);
  if (bonRows.length) {
    const first = bon[bonRows[0]].rows[0];
    console.log(`\n필드명(${bonRows[0]} 기준, ${Object.keys(first).length}개): ${Object.keys(first).join(", ")}`);
    console.log(`예시 1행: ${JSON.stringify(first).slice(0, 500)}`);
    for (const d of bonRows) {
      const names = [...new Set(bon[d].rows.map((r) => r.IDX_NM ?? ""))];
      console.log(`\n${d} 지수명 ${names.length}개: ${names.slice(0, 70).join(" / ")}${names.length > 70 ? " ..." : ""}`);
      const tr = names.filter((n) => /총수익|재투자|Total|TR/i.test(n)), px = names.filter((n) => /가격|Price|Clean|클린/i.test(n));
      console.log(`  이름에 총수익·재투자 포함 ${tr.length}개, 가격·클린 포함 ${px.length}개`);
    }
    const f = Object.keys(first).filter((k) => /EARN|REINV|PRC|TOT|NET|MKT|IDX/i.test(k));
    console.log(`지수 값 필드로 보이는 이름: ${f.join(", ")}`);
  }

  // ---- 4. 금시장 ----
  console.log("\n=== 4. 금시장 (gen/gold_bydd_trd) ===");
  console.log("| 날짜 | HTTP | respCode | respMsg | 행 수 |\n|---|---|---|---|---|");
  const gold: Record<string, Resp> = {};
  for (const d of GOLD_DATES) { gold[d] = await krx("gen/gold_bydd_trd", d, key); const r = gold[d]; console.log(`| ${d} | ${r.http} | ${r.code} | ${r.msg} | ${r.rows.length} |`); }
  for (const d of GOLD_DATES) if (gold[d].rows.length === 0 && gold[d].rawHead) console.log(`  (${d} 응답 앞부분: ${gold[d].rawHead})`);
  const gRows = GOLD_DATES.filter((d) => gold[d].rows.length);
  if (gRows.length) {
    console.log(`\n필드명(${gRows[0]} 기준): ${Object.keys(gold[gRows[0]].rows[0]).join(", ")}`);
    for (const d of gRows) console.log(`예시 ${d}: ${JSON.stringify(gold[d].rows.slice(0, 3)).slice(0, 500)}`);
  }

  // ---- 6. 서비스 목록 ----
  console.log("\n=== 6. 기존 코드의 KRX 호출부와 추가 엔드포인트 응답 확인 (기준일 20261008) ===");
  console.log("기존 코드에서 쓰는 엔드포인트: sto/stk_bydd_trd, sto/ksq_bydd_trd (scripts/backfill-stock-daily-prices.ts 등), idx/kospi_dd_trd, idx/kosdaq_dd_trd (scripts/backfill-index-daily-prices.ts). 모두 기준 URL https://data-dbg.krx.co.kr/svc/apis, 헤더 AUTH_KEY.");
  const extra = ["sto/knx_bydd_trd", "etp/etn_bydd_trd", "idx/krx_dd_trd", "idx/drvprod_dd_trd", "bon/kts_bydd_trd", "bon/bnd_bydd_trd", "bon/smb_bydd_trd", "gen/oil_bydd_trd", "gen/ets_bydd_trd", "drv/fut_bydd_trd", "esg/sri_bond_info"];
  console.log("| 엔드포인트 | HTTP | respCode | respMsg | 행 수 |\n|---|---|---|---|---|");
  for (const p of extra) { const r = await krx(p, "20261008", key); console.log(`| ${p} | ${r.http} | ${r.code} | ${r.msg} | ${r.rows.length} |`); }

  console.log("\n=== 실행 지표 ===");
  console.log(`KRX 요청 수: ${requests} (상한 ${REQUEST_CAP}) | DART 0 | KIS 0 | DB 읽기·쓰기 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
