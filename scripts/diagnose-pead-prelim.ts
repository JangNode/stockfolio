/**
 * [임시 연구 — 병합 금지] 연구 PEAD 잠정실적 공정공시 가능성 점검 + 파일럿(시험 아님, 시도 번호 소진 없음, 가격 성과 계산 없음, 연구 DB·Storage 쓰기 0).
 * DART 연구용 키(DART_API_KEY_2/_3)만 쓴다. (1) 공시 목록 API로 '영업(잠정)실적' 공시 건수 추정(분기 창 전체 건수 + 연도당 표본 페이지) (2) 20건 이내 원문 파일럿(원문은 저장하지 않고 파싱 값만 로그에 남긴다)
 * (3) 접수 시각 정보 확인 (4) 전체 수집 규모 추정. 호출 수는 PEAD_PRELIM.callCap 이내로 제한한다. 키 값은 출력하지 않는다.
 */
import AdmZip from "adm-zip";
import { downloadBuf, decodeTable } from "@/lib/nBookStore";
import { eventsByCorp, type FinRow, type FilingRow } from "@/lib/rFinMetrics";
import { R_STORE_PREFIX } from "@/lib/kodexSectorSatConfig";
import { PEAD_PRELIM as P } from "@/lib/peadConfig";
import { loadHarness, loadK200P, verifySnapshotManifest, storageLine, xfer, SNAP_END, f2, mulberry32 } from "./researchHarness";

const T0 = Date.now();
const BASE = "https://opendart.fss.or.kr/api";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
interface Row { corp_code: string; corp_name: string; stock_code: string; corp_cls: string; report_nm: string; rcept_no: string; rcept_dt: string; rm?: string; flr_nm?: string }
interface ListRes { status: string; message: string; total_count?: number; total_page?: number; list?: Row[] }

const keys = [{ name: "DART_API_KEY_2", value: process.env.DART_API_KEY_2 ?? "", off: false, used: 0 }, { name: "DART_API_KEY_3", value: process.env.DART_API_KEY_3 ?? "", off: false, used: 0 }];
let calls = 0;
const pickKey = (): (typeof keys)[number] => {
  if (calls >= P.callCap) throw new Error(`DART 호출 상한 ${P.callCap}건에 도달`);
  const k = keys.filter((x) => !x.off && x.value).sort((a, b) => a.used - b.used)[0];
  if (!k) throw new Error("사용 가능한 연구용 DART 키가 없음");
  k.used++; calls++;
  return k;
};
const ymd = (d: string): string => d.replace(/-/g, "");
async function list(params: Record<string, string | number>): Promise<ListRes> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const k = pickKey();
    await sleep(P.gapMs);
    const qs = new URLSearchParams({ crtfc_key: k.value, ...Object.fromEntries(Object.entries(params).map(([a, b]) => [a, String(b)])) });
    const res = await fetch(`${BASE}/list.json?${qs}`);
    const j = (await res.json()) as ListRes;
    if (j.status === "020") { k.off = true; continue; }
    if (j.status !== "000" && j.status !== "013") throw new Error(`list.json 오류 status ${j.status} ${j.message}`);
    return j;
  }
  throw new Error("list.json 연구용 키 한도");
}
const listP = (extra: Record<string, string | number>): Promise<ListRes> => list({ page_count: 100, sort: "date", sort_mth: "asc", ...extra });

async function main(): Promise<void> {
  console.log(`연구 PEAD 잠정실적 공정공시 점검 시작(시험 아님): ${new Date().toISOString()} | 키 ${keys.filter((x) => x.value).length}개 확인(값 비출력)`);
  if (keys.some((k) => !k.value)) throw new Error("DART_API_KEY_2, DART_API_KEY_3가 필요합니다.");
  if (!SNAP_END || process.env.PARQUET_CACHE_FROZEN !== "1") throw new Error("고정 스냅샷 모드가 아니면 실행하지 않는다");
  console.log(await verifySnapshotManifest());

  // ---- 프로브: 어느 세부 종류에 '영업(잠정)실적'이 들어 있나 ----
  const probeShare = new Map<string, { total: number; share: number; n: number; names: string }>();
  for (const code of P.detailCodes) {
    const ex: Record<string, string | number> = { bgn_de: ymd(P.probeFrom), end_de: ymd(P.probeTo), corp_cls: "Y", pblntf_ty: "I", ...(code === "I" ? {} : { pblntf_detail_ty: code }) };
    const r = await listP(ex);
    const rows = r.list ?? [];
    const hit = rows.filter((x) => x.report_nm.includes(P.keyword));
    const names = new Map<string, number>();
    for (const x of rows) { const nm = x.report_nm.replace(/\[[^\]]*\]/g, "").replace(/\s+/g, ""); names.set(nm, (names.get(nm) ?? 0) + 1); }
    probeShare.set(code, { total: r.total_count ?? 0, share: rows.length ? hit.length / rows.length : 0, n: rows.length, names: [...names].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([a, b]) => `${a} ${b}`).join(" | ") });
  }
  console.log(`\n=== 1-0. 프로브 (${P.probeFrom}~${P.probeTo}, 코스피 corp_cls=Y, 공시 종류 I; 날짜 오름차순 첫 100건) ===\n| 종류 코드 | 전체 건수 | 표본 | '${P.keyword}' 포함 비율 % | 보고서명 상위 |\n|---|---|---|---|---|`);
  for (const [c, v] of probeShare) console.log(`| ${c} | ${v.total} | ${v.n} | ${f2(v.share * 100)} | ${v.names} |`);
  const cand = P.detailCodes.filter((c) => (probeShare.get(c)?.share ?? 0) > 0).sort((a, b) => probeShare.get(a)!.total - probeShare.get(b)!.total);
  const code = cand[0];
  if (!code) throw new Error("프로브에서 영업(잠정)실적 보고서명이 한 건도 나오지 않음 — 중단");
  const typeParams: Record<string, string | number> = { pblntf_ty: "I", ...(code === "I" ? {} : { pblntf_detail_ty: code }) };
  console.log(`선택한 목록 필터: pblntf_ty=I${code === "I" ? "" : `, pblntf_detail_ty=${code}`} (전체 건수가 가장 작으면서 '${P.keyword}'가 나오는 종류)`);

  // ---- 1. 분기 창별 전체 건수(코스피) ----
  const windows: { y: string; from: string; to: string; total: number }[] = [];
  for (let y = Number(P.from.slice(0, 4)); y <= Number(P.to.slice(0, 4)); y++) {
    for (const [a, b] of [["01-01", "03-31"], ["04-01", "06-30"], ["07-01", "09-30"], ["10-01", "12-31"]]) {
      const from = `${y}-${a}`, to = `${y}-${b}` > P.to ? P.to : `${y}-${b}`;
      if (from > P.to) continue;
      const r = await list({ page_count: 1, bgn_de: ymd(from), end_de: ymd(to), corp_cls: "Y", ...typeParams });
      windows.push({ y: String(y), from, to, total: r.total_count ?? 0 });
    }
  }
  const years = [...new Set(windows.map((w) => w.y))];
  console.log(`\n=== 1-1. 분기 창별 공시(선택한 종류, 코스피) 전체 건수 ===\n${windows.map((w) => `${w.from}~${w.to} ${w.total}`).join(" | ")}`);

  // ---- 표본 페이지: 연도마다 sampleLoopPagesPerYear개를 연도 전체 페이지에서 시드 난수로 고른다 ----
  const rng = mulberry32(P.seed);
  const sampleRows = new Map<string, Row[]>();
  for (const y of years) {
    const ws = windows.filter((w) => w.y === y), pageCnt = ws.map((w) => Math.max(Math.ceil(w.total / 100), 0)), tot = pageCnt.reduce((a, b) => a + b, 0);
    if (!tot) continue;
    const picks = new Set<number>();
    while (picks.size < Math.min(P.sampleLoopPagesPerYear, tot)) picks.add(Math.floor(rng() * tot));
    const rows: Row[] = [];
    for (const g of picks) {
      let acc = 0, wi = 0;
      while (g >= acc + pageCnt[wi]) { acc += pageCnt[wi]; wi++; }
      const r = await listP({ bgn_de: ymd(ws[wi].from), end_de: ymd(ws[wi].to), corp_cls: "Y", page_no: g - acc + 1, ...typeParams });
      rows.push(...(r.list ?? []));
    }
    sampleRows.set(y, rows);
  }
  const isPrelim = (r: Row): boolean => r.report_nm.includes(P.keyword);
  const isCons = (r: Row): boolean => r.report_nm.includes("연결");
  const isCorr = (r: Row): boolean => r.report_nm.includes("정정");
  console.log(`\n=== 1-2. 연도별 '${P.keyword}' 접수 건수 추정 (코스피; 연도 전체 건수 × 표본 페이지 내 비율) ===\n| 연도 | 공시 종류 전체 건수 | 표본 건수 | 표본 중 영업(잠정)실적 | 비율 % | 추정 건수 | 그중 연결 % | 정정 % |\n|---|---|---|---|---|---|---|---|`);
  const estByYear = new Map<string, number>(), consShareByYear = new Map<string, number>();
  let estTotal = 0;
  for (const y of years) {
    const rows = sampleRows.get(y) ?? [], tot = windows.filter((w) => w.y === y).reduce((a, w) => a + w.total, 0), hit = rows.filter(isPrelim), share = rows.length ? hit.length / rows.length : 0;
    const est = Math.round(tot * share);
    estByYear.set(y, est); estTotal += est;
    consShareByYear.set(y, hit.length ? hit.filter(isCons).length / hit.length : NaN);
    console.log(`| ${y} | ${tot} | ${rows.length} | ${hit.length} | ${f2(share * 100)} | ${est} | ${f2(hit.length ? (hit.filter(isCons).length / hit.length) * 100 : NaN)} | ${f2(hit.length ? (hit.filter(isCorr).length / hit.length) * 100 : NaN)} |`);
  }
  console.log(`합계 추정 ${estTotal}건 (연결·별도 각각 별개 공시, 정정 포함; 표본이 연속 페이지 1~2개라 계절 편향 때문에 오차가 크다 — 정확한 건수는 전체 목록(아래 4절의 목록 호출)이 필요)`);
  const allSample = [...sampleRows.values()].flat(), prelimSample = allSample.filter((r) => isPrelim(r) && !isCorr(r));

  // ---- 자료 읽기(Storage 읽기만) ----
  const tab = async (name: string): Promise<Record<string, string | number | null>[]> => {
    const b = await downloadBuf(`${R_STORE_PREFIX}/${name}`);
    if (!b) throw new Error(`${R_STORE_PREFIX}/${name} 없음`);
    xfer.bytes += b.byteLength;
    return (await decodeTable(b)) as Record<string, string | number | null>[];
  };
  const finRows = (await tab("fin.parquet")) as unknown as FinRow[], filRows = (await tab("filings.parquet")) as unknown as FilingRow[];
  const stockOfCorp = new Map<string, string>();
  for (const r of finRows) if (r.stock_code) stockOfCorp.set(r.corp_code, r.stock_code);
  const evOrig = eventsByCorp(finRows, filRows);
  const regByCorp = new Map<string, FilingRow[]>();
  for (const f of filRows) if (f.correction === "N" && /(분기|반기|사업)보고서/.test(String(f.report_nm)) && !/연장/.test(String(f.report_nm))) { const l = regByCorp.get(f.corp_code) ?? []; l.push(f); regByCorp.set(f.corp_code, l); }
  for (const l of regByCorp.values()) l.sort((a, b) => (a.rcept_dt < b.rcept_dt ? -1 : 1));
  const nextReg = (corp: string, d: string): FilingRow | undefined => (regByCorp.get(corp) ?? []).find((f) => f.rcept_dt > d);
  const dayDiff = (a: string, b: string): number => (Date.parse(b) - Date.parse(a)) / 86_400_000;

  // ---- 1-3. 정기보고서보다 먼저 나온 일수 (표본 비정정 영업(잠정)실적 공시 → 같은 회사의 다음 정기보고서 접수일) ----
  const leads: number[] = [];
  let noMatch = 0;
  for (const r of prelimSample) { const nx = nextReg(r.corp_code, r.rcept_dt); if (nx && dayDiff(r.rcept_dt, nx.rcept_dt) <= 120) leads.push(dayDiff(r.rcept_dt, nx.rcept_dt)); else noMatch++; }
  leads.sort((a, b) => a - b);
  const q = (p: number): string => (leads.length ? String(leads[Math.min(Math.floor(leads.length * p), leads.length - 1)]) : "-");
  console.log(`\n=== 1-3. 정기보고서(분기·반기·사업)보다 먼저 나온 일수 — 표본 비정정 영업(잠정)실적 ${prelimSample.length}건 중 120일 안에 다음 정기보고서가 있는 ${leads.length}건 (없음 ${noMatch}건; filings.parquet은 2014~ 목록) ===`);
  console.log(`달력일 차이: 최소 ${q(0)} / 10분위 ${q(0.1)} / 25분위 ${q(0.25)} / 중앙값 ${q(0.5)} / 75분위 ${q(0.75)} / 90분위 ${q(0.9)} / 최대 ${leads.length ? leads[leads.length - 1] : "-"} | 7일 이상 먼저 ${leads.filter((x) => x >= 7).length}건(${f2((leads.filter((x) => x >= 7).length / Math.max(leads.length, 1)) * 100)}%), 14일 이상 ${leads.filter((x) => x >= 14).length}건, 30일 이상 ${leads.filter((x) => x >= 30).length}건`);
  const byYearLead = new Map<string, number[]>();
  for (const r of prelimSample) { const nx = nextReg(r.corp_code, r.rcept_dt); if (nx && dayDiff(r.rcept_dt, nx.rcept_dt) <= 120) { const l = byYearLead.get(r.rcept_dt.slice(0, 4)) ?? []; l.push(dayDiff(r.rcept_dt, nx.rcept_dt)); byYearLead.set(r.rcept_dt.slice(0, 4), l); } }
  console.log(`연도별 표본 수·중앙값(일): ${[...byYearLead].sort().map(([y, l]) => `${y} ${l.length}건·${[...l].sort((a, b) => a - b)[Math.floor(l.length / 2)]}`).join(" | ")}`);

  // ---- 1-4. 겹침 비율: 코스피 정기보고서(원본) 건수 대비 추정 잠정실적 건수 ----
  const h = await loadHarness();
  const { excluded, membAt } = await loadK200P(h);
  const regKospi = new Map<string, number>();
  for (const [corp, l] of regByCorp) { const code = stockOfCorp.get(corp); if (!code || excluded.has(code)) continue; for (const f of l) if (membAt(f.rcept_dt)?.get(code) === "KOSPI") regKospi.set(f.rcept_dt.slice(0, 4), (regKospi.get(f.rcept_dt.slice(0, 4)) ?? 0) + 1); }
  console.log(`\n=== 1-5. 코스피 정기보고서(비정정, 분기·반기·사업) 건수 대비 추정 '영업(잠정)실적' 건수 ===\n| 연도 | 코스피 정기보고서 | 추정 영업(잠정)실적(전체) | 연결만 추정 | 비율(전체 ÷ 정기) % | 비율(연결만) % |\n|---|---|---|---|---|---|`);
  for (const y of years) { const reg = regKospi.get(y) ?? 0, est = estByYear.get(y) ?? 0, cs = consShareByYear.get(y) ?? NaN; console.log(`| ${y} | ${reg} | ${est} | ${f2(est * cs)} | ${f2(reg ? (est / reg) * 100 : NaN)} | ${f2(reg ? ((est * cs) / reg) * 100 : NaN)} |`); }
  console.log(`(한 기업·분기에 연결과 별도 공시가 둘 다 나올 수 있어 전체 ÷ 정기는 상한에 가깝다. 분모는 정기보고서이므로 한 기업·분기당 1건.)`);

  // ---- 2. 파일럿: 서로 다른 연도·시장의 원문 20건 ----
  const kosdaq: Row[] = [];
  const kYears = [...years].sort();
  const kPickYears = [kYears[Math.floor(kYears.length * 0.25)], kYears[Math.floor(kYears.length * 0.75)]];
  for (const y of kPickYears.slice(0, P.kosdaqSamplePages)) {
    const ws = windows.filter((w) => w.y === y), w = ws[Math.floor(rng() * ws.length)];
    const r = await listP({ bgn_de: ymd(w.from), end_de: ymd(w.to), corp_cls: "K", page_no: 1, ...typeParams });
    kosdaq.push(...(r.list ?? []).filter((x) => isPrelim(x) && !isCorr(x)));
  }
  const shuffle = <T,>(a: T[]): T[] => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };
  const pilotK: Row[] = [], seenY = new Set<string>();
  const kospiPool = shuffle(prelimSample.filter((r) => { const nx = nextReg(r.corp_code, r.rcept_dt); return nx !== undefined && dayDiff(r.rcept_dt, nx.rcept_dt) <= 120; }));
  for (const r of kospiPool) { const y = r.rcept_dt.slice(0, 4); if (!seenY.has(y) && pilotK.length < P.pilotKospi) { seenY.add(y); pilotK.push(r); } }
  for (const r of kospiPool) if (pilotK.length < P.pilotKospi && !pilotK.includes(r)) pilotK.push(r);
  const kd = shuffle(kosdaq);
  const kdYear = new Set<string>(), pilotQ: Row[] = [];
  for (const r of kd) { const key = r.rcept_dt.slice(0, 4); if (pilotQ.length < P.pilotDocs - pilotK.length && (!kdYear.has(key) || pilotQ.length >= kdYear.size)) { kdYear.add(key); pilotQ.push(r); } }
  for (const r of kd) if (pilotQ.length < P.pilotDocs - pilotK.length && !pilotQ.includes(r)) pilotQ.push(r);
  const pilot = [...pilotK, ...pilotQ].slice(0, P.pilotDocs);
  console.log(`\n=== 2. 파일럿 ${pilot.length}건 (코스피 ${pilotK.length} + 코스닥 ${pilotQ.length}; 문서 호출 ${pilot.length}건, 원문은 저장하지 않고 파싱 값과 짧은 발췌만 로그에 남김) ===`);

  const decode = (buf: Buffer): string => { const u = buf.toString("utf8"); if ((u.match(/�/g) ?? []).length < 5) return u; try { return new TextDecoder("euc-kr").decode(buf); } catch { return u; } };
  const toText = (xml: string): string => xml
    .replace(/<\/(TD|TH|TE|TU)\s*>/gi, " | ").replace(/<\/(TR|P|BR|TITLE|SECTION-\d|TABLE|LIBRARY)\s*>/gi, "\n").replace(/<BR\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t ]+/g, " ").replace(/ ?\| ?(\| ?)+/g, " | ").replace(/\n\s*\n+/g, "\n");
  const numOf = (s: string): number | null => {
    const t = s.replace(/\s/g, "");
    const m = /^([(△▲\-－]?)(\d[\d,]*(?:\.\d+)?)\)?$/.exec(t);
    if (!m) return null;
    const v = Number(m[2].replace(/,/g, ""));
    return m[1] ? -v : v;
  };
  const unitOf = (text: string): { unit: string; scale: number } => { const m = /단위\s*[:：]?\s*(백만원|천원|억원|원)/.exec(text); const u = m?.[1] ?? "불명"; return { unit: u, scale: u === "백만원" ? 1e6 : u === "천원" ? 1e3 : u === "억원" ? 1e8 : u === "원" ? 1 : NaN }; };
  interface Res { bytes: number; unit: string; scale: number; rowText: string; headText: string; cur: number | null; prevY: number | null; timeHits: string[]; textSample: string; quarterLabel: string }
  const parseDoc = (text: string, bytes: number): Res => {
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const { unit, scale } = unitOf(text);
    const idx = lines.findIndex((l) => /^\s*\|?\s*영업\s*이익(?!률)/.test(l) || /\|\s*영업\s*이익(?!률)\s*\|/.test(l));
    let rowText = "", headText = "", cur: number | null = null, prevY: number | null = null;
    if (idx >= 0) {
      rowText = lines[idx];
      const cells = rowText.split("|").map((c) => c.trim()).filter(Boolean);
      const nums = cells.slice(1).map(numOf);
      const hdr = lines.slice(Math.max(0, idx - 12), idx).reverse().find((l) => l.includes("전년"));
      headText = hdr ?? "";
      const roles = (hdr ?? "").split("|").map((c) => c.trim()).filter(Boolean).filter((c) => !/^구\s*분$/.test(c)).map((c) => (/전년\s*동기\s*(대비|증감)|증감|대비|%/.test(c) ? "pct" : /전년\s*동기/.test(c) ? "prevY" : /직전|전기|전분기/.test(c) ? "prevQ" : /당|해당|금번|잠정|실적/.test(c) ? "cur" : "x"));
      if (roles.length === nums.length && roles.includes("cur") && roles.includes("prevY")) { cur = nums[roles.indexOf("cur")]; prevY = nums[roles.indexOf("prevY")]; }
      else { cur = nums[0] ?? null; prevY = nums.length >= 4 ? nums[3] : null; }
    }
    const tm = [...text.matchAll(/(\d{1,2}\s*:\s*\d{2}|\d{1,2}\s*시\s*\d{0,2}\s*분?|장\s*중|장\s*종료|장\s*마감|시간외|공시\s*(?:일시|시각|시간)|정보\s*제공\s*(?:일시|일자))/g)].map((m) => m[0].replace(/\s+/g, " ")).slice(0, 8);
    const ql = /(\d{4})\s*년?\s*(\d)\s*분기|(\d{4})\s*년\s*(상반기|반기|연간|\d분기)|제\s*\d+\s*기\s*(\d분기|반기)?/.exec(text)?.[0] ?? "";
    const si = Math.max(0, text.search(/매출액/));
    return { bytes, unit, scale, rowText, headText, cur, prevY, timeHits: tm, textSample: text.slice(Math.max(0, si - 200), si + 1200).replace(/\n/g, " ⏎ "), quarterLabel: ql };
  };
  let docBytes = 0, nParsed = 0, nMatchEv = 0, nMatchFin = 0, nCmp = 0, nTime = 0;
  const units = new Map<string, number>();
  let pi = 0;
  for (const r of pilot) {
    pi++;
    const k = pickKey();
    await sleep(P.gapMs);
    const res = await fetch(`${BASE}/document.xml?${new URLSearchParams({ crtfc_key: k.value, rcept_no: r.rcept_no })}`);
    const buf = Buffer.from(await res.arrayBuffer());
    docBytes += buf.byteLength;
    if (buf[0] !== 0x50 || buf[1] !== 0x4b) { console.log(`#${pi} ${r.corp_cls} ${r.rcept_dt} ${r.corp_name} ${r.report_nm}: zip 아님(${buf.byteLength} B) — ${buf.toString("utf8").slice(0, 120).replace(/\n/g, " ")}`); continue; }
    const zip = new AdmZip(buf);
    const ent = zip.getEntries().filter((e) => !e.isDirectory);
    const raw = decode(ent[0].getData());
    const text = toText(raw);
    const d = parseDoc(text, buf.byteLength);
    units.set(d.unit, (units.get(d.unit) ?? 0) + 1);
    if (d.timeHits.length) nTime++;
    const nx = nextReg(r.corp_code, r.rcept_dt);
    const ev = nx ? (evOrig.get(r.corp_code) ?? []).find((e) => e.rceptNo === nx.rcept_no) : undefined;
    const fs = isCons(r) ? "CFS" : "OFS";
    const fr = nx ? finRows.find((x) => x.rcept_no === nx.rcept_no && x.fs_div === fs && x.status === "orig") : undefined;
    const add = fr && (fr.reprt_code === "11012" || fr.reprt_code === "11014");
    const finCur = fr ? (add ? fr.oi_c : fr.oi_c) : null, finPrev = fr ? fr.oi_p : null;
    const ok = d.cur !== null && d.prevY !== null && Number.isFinite(d.scale);
    if (ok) nParsed++;
    const near = (a: number, b: number | null | undefined): boolean => b !== null && b !== undefined && Math.abs(a - b) <= Math.max(d.scale, 1) * 1.01 + Math.abs(b) * 0.001;
    let cmp = "비교 불가(다음 정기보고서의 값 없음)";
    if (ok && (ev || fr)) {
      nCmp++;
      const mEv = ev && ev.qOi !== null && ev.qOiPrev !== null ? near((d.cur as number) * d.scale, ev.qOi) && near((d.prevY as number) * d.scale, ev.qOiPrev) : null;
      const mFin = fr && fr.reprt_code !== "11011" ? near((d.cur as number) * d.scale, finCur) && near((d.prevY as number) * d.scale, finPrev) : null;
      if (mEv) nMatchEv++;
      if (mFin) nMatchFin++;
      cmp = `정기보고서 이벤트(연결 우선) 당분기/전년동기 ${ev?.qOi ?? "-"} / ${ev?.qOiPrev ?? "-"} → ${mEv === null ? "-" : mEv ? "일치" : "불일치"} | fin 행(${fs}${fr ? ` ${fr.reprt_code}` : " 없음"}) ${finCur ?? "-"} / ${finPrev ?? "-"} → ${mFin === null ? "-" : mFin ? "일치" : "불일치"}`;
    }
    console.log(`#${pi} [${r.corp_cls}] ${r.rcept_dt} ${r.corp_name} ${r.report_nm} (${r.rcept_no}) | zip ${buf.byteLength} B, 압축 해제 ${raw.length} 자, 파일 ${ent.length}개 | 단위 ${d.unit} | 기간 표기 "${d.quarterLabel}" | 다음 정기보고서 ${nx ? `${nx.rcept_dt}(+${dayDiff(r.rcept_dt, nx.rcept_dt)}일)` : "없음"}`);
    console.log(`    영업이익 행: ${d.rowText.slice(0, 220) || "(찾지 못함)"} | 헤더: ${d.headText.slice(0, 200) || "-"} | 파싱 당기 ${d.cur ?? "-"} / 전년동기 ${d.prevY ?? "-"} | ${cmp}`);
    console.log(`    시각 관련 문구: ${d.timeHits.join(", ") || "없음"} | 발췌: ${d.textSample.slice(0, 900)}`);
  }
  console.log(`\n파일럿 요약: 문서 ${pilot.length}건, 내려받은 zip 합계 ${docBytes} B(평균 ${Math.round(docBytes / Math.max(pilot.length, 1))} B), 영업이익 당기·전년동기를 자동 추출한 문서 ${nParsed}건(${f2((nParsed / Math.max(pilot.length, 1)) * 100)}%), 정기보고서 값과 비교한 ${nCmp}건 중 이벤트 값 일치 ${nMatchEv}건·fin 행 값 일치 ${nMatchFin}건, 단위 분포 ${[...units].map(([a, b]) => `${a} ${b}`).join(" / ")}, 시각 관련 문구가 있는 문서 ${nTime}건`);

  // ---- 4. 전체 수집 추정 ----
  const listPages = windows.reduce((a, w) => a + Math.ceil(w.total / 100), 0), avgBytes = docBytes / Math.max(pilot.length, 1);
  const addCalls = listPages + estTotal;
  console.log(`\n=== 4. 전체 수집 추정 (코스피 ${P.from}~${P.to}) ===\n목록 호출(선택한 종류 전체 페이지, 분기 창 ${windows.length}개, 페이지 100건): 약 ${listPages}건 | 문서(원문) 호출: 추정 ${estTotal}건(상한 추정 오차 큼) | 추가 호출 합계 약 ${addCalls}건 | 이번 점검 호출 ${calls}건(키별 ${keys.map((x) => `${x.name} ${x.used}`).join(", ")})`);
  console.log(`내려받기: 문서 평균 ${Math.round(avgBytes)} B × ${estTotal} ≈ ${f2((avgBytes * estTotal) / 1048576)} MiB + 목록 응답(페이지당 수십 KB 가정) | 하루 한도 ${P.dailyCapPerKey * 2}건(키 2개) 기준 소요 ${f2(addCalls / (P.dailyCapPerKey * 2))}일 | R 누적 ${P.rUsed} + 점검 ${calls} + 추가 ${addCalls} = ${P.rUsed + calls + addCalls}건 (상한 ${P.totalCap}) → ${P.rUsed + calls + addCalls <= P.totalCap ? "상한 안" : "상한 초과"}`);
  console.log(`Storage 추가분(파싱 결과 Parquet): 문서당 약 100~200 B × ${estTotal} ≈ ${f2((100 * estTotal) / 1048576)}~${f2((200 * estTotal) / 1048576)} MiB`);
  console.log(`\n${storageLine()} | Supabase 쓴 행 0 | Storage 쓰기 0 | DART 호출 ${calls}건(연구용 키만) | 가격 성과 계산 없음 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분 | 시도 번호 소진 없음`);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });
