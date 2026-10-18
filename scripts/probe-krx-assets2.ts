/**
 * [임시 점검 — 병합 금지, 읽기 전용, 저장 없음] KRX 서비스 승인 후 ETF·채권지수·금·석유 재점검.
 * KRX 요청 총 50건 이하(AUTH_KEY = 기존 KRX_API_KEY, 키 값 출력 금지). DART·KIS 0건. DB는 KOSPI 지수 읽기만(거래일 수 계산용). 숫자와 표만 출력한다.
 */
import { getIndexPriceSeries } from "@/lib/betaPriceHistoryStorage";

const T0 = Date.now();
const BASE = "https://data-dbg.krx.co.kr/svc/apis";
const REQUEST_CAP = 50;
let requests = 0;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
type Row = Record<string, string>;
interface Resp { http: number | string; code: string; msg: string; rows: Row[]; head: string }
async function krx(path: string, basDd: string, key: string): Promise<Resp> {
  if (requests >= REQUEST_CAP) return { http: "-", code: "-", msg: "요청 상한", rows: [], head: "" };
  requests++;
  await sleep(300);
  try {
    const res = await fetch(`${BASE}/${path}?basDd=${basDd}`, { headers: { AUTH_KEY: key } });
    const text = await res.text();
    let j: Record<string, unknown> | null = null;
    try { j = JSON.parse(text) as Record<string, unknown>; } catch { j = null; }
    return { http: res.status, code: String(j?.respCode ?? "-"), msg: String(j?.respMsg ?? "-"), rows: (j?.OutBlock_1 as Row[] | undefined) ?? [], head: text.slice(0, 160).replace(/\s+/g, " ") };
  } catch (e) { return { http: "fetch 실패", code: "-", msg: e instanceof Error ? e.message : String(e), rows: [], head: "" }; }
}
const nm = (r: Row): string => r.ISU_NM ?? r.IDX_NM ?? "";
const cd = (r: Row): string => r.ISU_SRT_CD ?? r.ISU_CD ?? "";

async function table(label: string, path: string, dates: string[], key: string): Promise<Record<string, Resp>> {
  console.log(`\n--- ${label} (${path}) ---`);
  console.log("| 날짜 | HTTP | respCode | respMsg | 행 수 |\n|---|---|---|---|---|");
  const out: Record<string, Resp> = {};
  for (const d of dates) { out[d] = await krx(path, d, key); const r = out[d]; console.log(`| ${d} | ${r.http} | ${r.code} | ${r.msg} | ${r.rows.length} |`); }
  const ok = dates.filter((d) => out[d].rows.length);
  if (ok.length) {
    const fieldSets = new Set(ok.map((d) => Object.keys(out[d].rows[0]).join(",")));
    console.log(`필드명(${ok[0]} 기준, ${Object.keys(out[ok[0]].rows[0]).length}개): ${Object.keys(out[ok[0]].rows[0]).join(", ")} | 날짜별 필드 구성 종류 ${fieldSets.size}`);
  } else for (const d of dates) if (out[d].head) { console.log(`응답 앞부분(${d}): ${out[d].head}`); break; }
  return out;
}

async function main(): Promise<void> {
  const key = process.env.KRX_API_KEY;
  if (!key) throw new Error("KRX_API_KEY 환경변수가 필요합니다.");
  console.log(`KRX 재점검 시작(읽기 전용): ${new Date().toISOString()} | 요청 상한 ${REQUEST_CAP}`);
  const D5 = ["20100104", "20120102", "20150102", "20200102", "20261008"];

  console.log("\n=== 1. 엔드포인트 재요청 ===");
  const etf = await table("ETF", "etp/etf_bydd_trd", D5, key);
  const bon = await table("채권지수", "idx/bon_dd_trd", D5, key);
  const gold = await table("금", "gen/gold_bydd_trd", ["20140401", "20200102", "20261008"], key);
  const oil = await table("석유", "gen/oil_bydd_trd", ["20130102", "20200102", "20261008"], key);

  // ---- 2. 경로 이름 근거(401 유지 시) ----
  const all401 = [["etp/etf_bydd_trd", etf], ["idx/bon_dd_trd", bon], ["gen/gold_bydd_trd", gold], ["gen/oil_bydd_trd", oil]].filter(([, r]) => Object.values(r as Record<string, Resp>).every((x) => x.rows.length === 0)) as [string, Record<string, Resp>][];
  console.log("\n=== 2. 여전히 응답 행이 없는 엔드포인트의 경로 근거 ===");
  if (!all401.length) console.log("모든 엔드포인트에서 행이 왔습니다.");
  else {
    console.log(`행이 없는 엔드포인트: ${all401.map(([p]) => p).join(", ")}`);
    const ctl = await krx("sto/stk_bydd_trd", "20261008", key);
    const bogus = await krx("etp/zzz_nonexistent_endpoint", "20261008", key);
    const bogus2 = await krx("zzz/etf_bydd_trd", "20261008", key);
    console.log("| 대조 요청 | HTTP | respCode | respMsg | 행 수 |\n|---|---|---|---|---|");
    console.log(`| sto/stk_bydd_trd (기존 코드 사용 경로, 대조) | ${ctl.http} | ${ctl.code} | ${ctl.msg} | ${ctl.rows.length} |`);
    console.log(`| etp/zzz_nonexistent_endpoint (존재하지 않는 경로) | ${bogus.http} | ${bogus.code} | ${bogus.msg} | ${bogus.rows.length} |`);
    console.log(`| zzz/etf_bydd_trd (존재하지 않는 분류) | ${bogus2.http} | ${bogus2.code} | ${bogus2.msg} | ${bogus2.rows.length} |`);
    console.log("근거 해석(사실): 대조 경로가 200이면 키는 유효. 존재하지 않는 경로의 응답 코드가 위 401과 같으면 응답 코드만으로 '미승인'과 '경로 이름 오류'를 구분할 수 없음. 다르면 구분 가능.");
    console.log("기존 코드의 KRX 호출부(scripts/backfill-stock-daily-prices.ts 등)는 sto/stk_bydd_trd, sto/ksq_bydd_trd, idx/kospi_dd_trd, idx/kosdaq_dd_trd만 사용하고, ETF·채권·금·석유 경로 이름을 확인할 근거는 코드에 없음. 이번 경로 이름(etp/etf_bydd_trd 등)은 KRX Open API 문서 이름이라는 제 기억에 근거한 추측.");
  }

  // ---- 3. ETF ----
  console.log("\n=== 3. ETF ===");
  const WANT = ["069500", "114260", "148070", "153130", "132030", "261240"];
  const KW = ["국고채", "골드", "달러", "단기", "채권"];
  const etfOk = D5.filter((d) => etf[d].rows.length);
  if (!etfOk.length) console.log("ETF 응답 행이 없어 확인 불가.");
  else {
    console.log(`예시 1행(${etfOk[0]}): ${JSON.stringify(etf[etfOk[0]].rows[0]).slice(0, 700)}`);
    console.log("| 종목코드 | 날짜 | 있음 | 종목명 | 종가 | NAV | 거래량 | 시가총액 | 기초지수 |\n|---|---|---|---|---|---|---|---|---|");
    for (const c of WANT) for (const d of D5) {
      const rows = etf[d].rows;
      if (!rows.length) { console.log(`| ${c} | ${d} | (응답 행 없음) | - | - | - | - | - | - |`); continue; }
      const r = rows.find((x) => cd(x) === c || (x.ISU_CD ?? "").includes(c));
      console.log(r ? `| ${c} | ${d} | O | ${nm(r)} | ${r.TDD_CLSPRC ?? "-"} | ${r.NAV ?? "-"} | ${r.ACC_TRDVOL ?? "-"} | ${r.MKTCAP ?? "-"} | ${r.IDX_IND_NM ?? "-"} |` : `| ${c} | ${d} | X | - | - | - | - | - | - |`);
    }
    console.log("\n이름에 '국고채'·'골드'·'달러'·'단기'·'채권' 포함 종목 (조회한 5개 날짜 중 처음 보인 날짜; 날짜 간격이 넓어 정확한 상장일 아님)");
    console.log("| 코드 | 종목명 | 키워드 | 처음 보인 날짜 | 최신 응답 종가 | 최신 NAV |\n|---|---|---|---|---|---|");
    const seen = new Map<string, { name: string; kw: string[]; first: string; close: string; nav: string }>();
    for (const d of etfOk) for (const r of etf[d].rows) {
      const kws = KW.filter((k) => nm(r).includes(k));
      if (!kws.length) continue;
      const c = cd(r), prev = seen.get(c);
      seen.set(c, { name: nm(r), kw: kws, first: prev?.first ?? d, close: r.TDD_CLSPRC ?? "-", nav: r.NAV ?? "-" });
    }
    for (const [c, v] of [...seen.entries()].sort((a, b) => (a[1].first < b[1].first ? -1 : a[1].first > b[1].first ? 1 : a[0] < b[0] ? -1 : 1))) console.log(`| ${c} | ${v.name} | ${v.kw.join("·")} | ${v.first} | ${v.close} | ${v.nav} |`);
    for (const d of D5) console.log(`  ${d}: 전체 ${etf[d].rows.length}행, 키워드 해당 ${etf[d].rows.filter((r) => KW.some((k) => nm(r).includes(k))).length}행`);
    const fields = new Set<string>();
    for (const d of etfOk) for (const k of Object.keys(etf[d].rows[0])) fields.add(k);
    const dv = [...fields].filter((k) => /DIV|DIST|분배|배당|ADJ|조정|PAY/i.test(k));
    console.log(`분배금·배당·조정 가격으로 보이는 필드: ${dv.length ? dv.join(", ") : "없음"}`);
  }

  // ---- 4. 채권지수 ----
  console.log("\n=== 4. 채권지수 ===");
  const bonOk = D5.filter((d) => bon[d].rows.length);
  if (!bonOk.length) console.log("채권지수 응답 행이 없어 확인 불가.");
  else {
    const base = bonOk[0];
    console.log(`예시 1행(${base}): ${JSON.stringify(bon[base].rows[0]).slice(0, 700)}`);
    const names0 = [...new Set(bon[base].rows.map(nm))];
    console.log(`\n${base} 지수명 전체 ${names0.length}개:\n${names0.join(" / ")}`);
    for (const d of bonOk.slice(1)) {
      const names = [...new Set(bon[d].rows.map(nm))];
      const added = names.filter((n) => !names0.includes(n));
      console.log(`\n${d}: 지수명 ${names.length}개, ${base}에 없던 이름 ${added.length}개${added.length ? `: ${added.slice(0, 60).join(" / ")}` : ""}`);
    }
    const gov = bon[base].rows.filter((r) => /국고채/.test(nm(r)));
    console.log(`\n${base} '국고채' 포함 지수 ${gov.length}개의 값 필드:`);
    const numKeys = gov.length ? Object.keys(gov[0]).filter((k) => !["BAS_DD", "IDX_CLSS", "IDX_NM"].includes(k)) : [];
    console.log("| 지수명 | " + numKeys.join(" | ") + " |\n|---|" + numKeys.map(() => "---").join("|") + "|");
    for (const r of gov.slice(0, 40)) console.log(`| ${nm(r)} | ${numKeys.map((k) => r[k]).join(" | ")} |`);
    const tr = names0.filter((n) => /총수익|재투자|Total|TR\b/i.test(n)), px = names0.filter((n) => /가격|Price|클린|Clean/i.test(n));
    console.log(`\n지수명에 총수익·재투자 포함 ${tr.length}개, 가격·클린 포함 ${px.length}개 (${base})`);
    console.log(`총수익·재투자 포함 이름: ${tr.slice(0, 30).join(" / ") || "없음"}`);
    console.log(`가격·클린 포함 이름: ${px.slice(0, 30).join(" / ") || "없음"}`);
  }

  // ---- 5. 금 ----
  console.log("\n=== 5. 금 ===");
  for (const d of ["20140401", "20200102", "20261008"]) {
    const r = gold[d];
    console.log(`${d}: ${r.rows.length}행${r.rows.length ? ` | ${JSON.stringify(r.rows.slice(0, 4)).slice(0, 700)}` : ""}`);
  }

  // ---- 6. 석유 ----
  console.log("\n=== 6. 석유 ===");
  for (const d of ["20130102", "20200102", "20261008"]) {
    const r = oil[d];
    console.log(`${d}: ${r.rows.length}행 | 상품: ${[...new Set(r.rows.map(nm))].join(" / ") || "-"}`);
    if (r.rows.length) console.log(`  예시: ${JSON.stringify(r.rows.slice(0, 3)).slice(0, 600)}`);
  }

  // ---- 7. 요청 수 ----
  const kospi = await getIndexPriceSeries("KOSPI", "2010-01-04", "2026-10-08");
  const days = kospi.map((p) => p.tradeDate).filter((d) => d >= "2010-01-04" && d <= "2026-10-08");
  const cnt = (from: string): number => days.filter((d) => d >= from).length;
  console.log("\n=== 7. 전체 일별 이력 수집 요청 수 추정 (날짜 1개당 요청 1건 가정, 거래일 = DB의 KOSPI 지수 일자) ===");
  console.log(`2010-01-04~2026-10-08 거래일 ${days.length}일`);
  console.log("| 엔드포인트 | 수집 시작일 | 거래일 수 = 요청 수 |\n|---|---|---|");
  console.log(`| etp/etf_bydd_trd | 2010-01-04 | ${days.length} |`);
  console.log(`| idx/bon_dd_trd | 2010-01-04 | ${days.length} |`);
  console.log(`| gen/gold_bydd_trd | 2014-04-01 | ${cnt("2014-04-01")} |`);
  console.log(`| gen/oil_bydd_trd | 2013-01-02 | ${cnt("2013-01-02")} |`);
  console.log(`| 합계 | - | ${days.length * 2 + cnt("2014-04-01") + cnt("2013-01-02")} |`);

  console.log("\n=== 실행 지표 ===");
  console.log(`KRX 요청 수: ${requests} (상한 ${REQUEST_CAP}) | DART 0 | KIS 0 | DB 읽기 KOSPI ${kospi.length}행·쓰기 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
