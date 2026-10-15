/**
 * [임시 점검 — 병합 금지, 읽기 전용] 재무 데이터 2010~ 확보 가능성 점검(DART·KRX 외부 요청 총 25건 이하, 쓰기·저장 없음).
 * 항목 2(DART), 3(KRX 일별매매정보 경로 + 대안 경로), 4(시점 유효성), 5(회계기준 전환)를 실행한다.
 * 항목 1(DB 보유 현황)은 scripts/probe-fundamentals-2010.sql(psql), 항목 6은 보고서에서 측정값으로 추정한다.
 * 숫자와 사실만 출력한다.
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";

// ---- 점검 상수 ----
const EXTERNAL_REQUEST_BUDGET = 25;
const DART_BASE_URL = "https://opendart.fss.or.kr/api";
const KRX_BASE_URL = "https://data-dbg.krx.co.kr/svc/apis/sto";
const KRX_ALT_URL = "https://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd";
const KRX_ALT_BLD = "dbms/MDC/STAT/standard/MDCSTAT03501"; // 개별종목 PER/PBR/배당수익률
const DART_SAMPLE_STOCK = "005930";
const DART_YEARS = [2010, 2011, 2012, 2013, 2014, 2015];
const ITEM3_DATES = ["2010-01-29", "2011-01-31", "2012-06-29", "2013-12-30", "2014-06-30"];
const ITEM3_KOSDAQ_DATE = "2014-06-30"; // 요청 수 절약: KOSDAQ은 한 날짜만
const ITEM3_BASE_INFO_DATE = "2014-06-30";
const ITEM5_STOCKS = ["005930", "005380", "051910", "035420", "000660"]; // 삼성전자, 현대차, LG화학, NAVER, SK하이닉스
const ITEM5_EXTRA_DATES = ["2010-12-30", "2011-03-31", "2011-06-30"]; // 2010-01-29, 2011-01-31은 항목 3 스냅샷 재사용
const ITEM4_DATES = ["2018-02-28", "2018-03-30", "2018-05-31"];
const ITEM4_SAMPLE_SIZE = 30;
const ITEM4_FISCAL_YEAR = 2017;
const ITEM4_RCEPT_FROM = "2018-03-01";
const ITEM4_RCEPT_TO = "2018-04-30";

let used = 0;
const reqLog: string[] = [];
function maskUrl(u: string): string { return u.replace(/(crtfc_key=)[^&]+/, "$1***"); }

interface ExtResult { status: number; ms: number; bytes: number; text: string }
async function ext(label: string, url: string, init?: RequestInit): Promise<ExtResult | null> {
  if (used >= EXTERNAL_REQUEST_BUDGET) { console.log(`[요청 한도 도달] ${label} 생략`); return null; }
  used++;
  const t0 = Date.now();
  try {
    const res = await fetch(url, init);
    const buf = Buffer.from(await res.arrayBuffer());
    const r = { status: res.status, ms: Date.now() - t0, bytes: buf.length, text: buf.toString("utf-8") };
    reqLog.push(`#${used} ${label} | HTTP ${r.status} | ${r.bytes} B | ${r.ms} ms`);
    return r;
  } catch (e) {
    reqLog.push(`#${used} ${label} | 요청 실패: ${e instanceof Error ? e.message : String(e)} | ${Date.now() - t0} ms`);
    return null;
  }
}
const parseJson = (s: string): unknown => { try { return JSON.parse(s); } catch { return null; } };
const num = (s: unknown): number => { const t = String(s ?? "").replace(/,/g, "").trim(); return t === "" || t === "-" ? NaN : Number(t); };
const f2 = (x: number): string => (Number.isFinite(x) ? x.toFixed(2) : "-");
function pct(v: number[], p: number): number {
  if (!v.length) return NaN;
  const s = [...v].sort((a, b) => a - b), x = (p / 100) * (s.length - 1), lo = Math.floor(x), hi = Math.ceil(x);
  return s[lo] + (s[hi] - s[lo]) * (x - lo);
}
const dayDiff = (a: string, b: string): number => (Date.parse(b) - Date.parse(a)) / 86_400_000;

export interface FundRow { stock_code: string; rcept_date: string; net_income_parent: number | null; equity_parent: number | null; fs_div: string }
export interface Deps {
  dartKey: string;
  krxKey: string;
  corpCode: (stockCode: string) => Promise<string | null>;
  fundRowsForYear: (fiscalYear: number, from: string, to: string) => Promise<FundRow[]>;
}

interface AltRow { code: string; name: string; eps: number; bps: number; per: number; pbr: number; dps: number; dvd: number; epsRaw: string }
interface AltSnap { date: string; rows: AltRow[]; fields: string[]; bytes: number; ms: number }

async function fetchAlt(date: string): Promise<{ snap: AltSnap | null; why: string }> {
  const body = new URLSearchParams({ bld: KRX_ALT_BLD, searchType: "1", mktId: "ALL", trdDd: date.replaceAll("-", ""), isuCd: "", csvxls_isNo: "false" }).toString();
  const r = await ext(`KRX 대안 경로(data.krx.co.kr MDCSTAT03501) ${date}`, KRX_ALT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "User-Agent": "Mozilla/5.0",
      Referer: "http://data.krx.co.kr/contents/MDC/MDI/mdiLoader/index.cmd?menuId=MDC0201020506",
    },
    body,
  });
  if (!r) return { snap: null, why: "요청 실패 또는 한도 도달" };
  const j = parseJson(r.text) as { output?: Record<string, string>[] } | null;
  if (r.status !== 200 || !j || !Array.isArray(j.output) || j.output.length === 0) {
    return { snap: null, why: `HTTP ${r.status}, 본문 앞부분: ${r.text.slice(0, 120).replace(/\s+/g, " ")}` };
  }
  const rows = j.output.map((o) => ({
    code: o.ISU_SRT_CD ?? "", name: o.ISU_ABBRV ?? "", eps: num(o.EPS), bps: num(o.BPS), per: num(o.PER), pbr: num(o.PBR), dps: num(o.DPS), dvd: num(o.DVD_YLD), epsRaw: String(o.EPS ?? ""),
  }));
  return { snap: { date, rows, fields: Object.keys(j.output[0]), bytes: r.bytes, ms: r.ms }, why: "" };
}

export async function runProbe(deps: Deps): Promise<void> {
  // ---- 항목 2: DART ----
  console.log("\n=== 항목 2: DART 오픈 API (fnlttSinglAcntAll, 005930, 사업보고서 11011, CFS) ===");
  const corp = await deps.corpCode(DART_SAMPLE_STOCK);
  console.log(`corp_code(${DART_SAMPLE_STOCK}): ${corp ?? "없음"} (DB dart_corp_codes 조회 1행)`);
  console.log("| 회계연도 | HTTP | DART status | message | 계정 행 수 | 응답 크기 | 소요 ms |");
  console.log("|---|---|---|---|---|---|---|");
  let firstDartYear: number | null = null;
  if (corp) {
    for (const y of DART_YEARS) {
      const url = `${DART_BASE_URL}/fnlttSinglAcntAll.json?crtfc_key=${deps.dartKey}&corp_code=${corp}&bsns_year=${y}&reprt_code=11011&fs_div=CFS`;
      const r = await ext(`DART ${DART_SAMPLE_STOCK} FY${y}`, url);
      if (!r) { console.log(`| ${y} | 실패 | - | - | - | - | - |`); continue; }
      const j = parseJson(r.text) as { status?: string; message?: string; list?: unknown[] } | null;
      const n = j?.list?.length ?? 0;
      if (j?.status === "000" && n > 0 && firstDartYear === null) firstDartYear = y;
      console.log(`| ${y} | ${r.status} | ${j?.status ?? "-"} | ${j?.message ?? "-"} | ${n} | ${r.bytes} B | ${r.ms} |`);
    }
  }
  console.log(`2010~2015 중 데이터가 있는 가장 이른 회계연도: ${firstDartYear ?? "없음"}`);

  // ---- 항목 3: KRX 일별매매정보 경로 ----
  console.log("\n=== 항목 3: KRX (일별매매정보 백필과 같은 경로: data-dbg.krx.co.kr/svc/apis/sto, AUTH_KEY) ===");
  console.log("| 날짜 | 시장 | HTTP | 행 수 | 응답 필드명 | PER/PBR/EPS/BPS/DPS/배당수익률 필드 유무 | 응답 크기 | 소요 ms |");
  console.log("|---|---|---|---|---|---|---|---|");
  const fundamentalFieldRe = /(^|_)(PER|PBR|EPS|BPS|DPS|DVD|YLD)(_|$)/i;
  const dailyJobs: ["stk_bydd_trd" | "ksq_bydd_trd", string][] = [
    ...ITEM3_DATES.map((d): ["stk_bydd_trd", string] => ["stk_bydd_trd", d]),
    ["ksq_bydd_trd", ITEM3_KOSDAQ_DATE],
  ];
  for (const [ep, d] of dailyJobs) {
    const r = await ext(`KRX ${ep} ${d}`, `${KRX_BASE_URL}/${ep}?basDd=${d.replaceAll("-", "")}`, { headers: { AUTH_KEY: deps.krxKey } });
    if (!r) { console.log(`| ${d} | ${ep} | 실패 | - | - | - | - | - |`); continue; }
    const j = parseJson(r.text) as { OutBlock_1?: Record<string, string>[] } | null;
    const rows = j?.OutBlock_1 ?? [];
    const fields = rows[0] ? Object.keys(rows[0]) : [];
    const has = fields.filter((f) => fundamentalFieldRe.test(f));
    console.log(`| ${d} | ${ep} | ${r.status} | ${rows.length} | ${fields.join(",") || "-"} | ${has.length ? has.join(",") : "없음"} | ${r.bytes} B | ${r.ms} |`);
  }
  const bi = await ext(`KRX stk_isu_base_info ${ITEM3_BASE_INFO_DATE}`, `${KRX_BASE_URL}/stk_isu_base_info?basDd=${ITEM3_BASE_INFO_DATE.replaceAll("-", "")}`, { headers: { AUTH_KEY: deps.krxKey } });
  if (bi) {
    const j = parseJson(bi.text) as { OutBlock_1?: Record<string, string>[] } | null;
    const rows = j?.OutBlock_1 ?? [];
    console.log(`종목기본정보(stk_isu_base_info ${ITEM3_BASE_INFO_DATE}): HTTP ${bi.status}, 행 ${rows.length}, 필드 ${rows[0] ? Object.keys(rows[0]).join(",") : "-"}, ${bi.bytes} B, ${bi.ms} ms${rows.length === 0 ? `, 본문 앞부분: ${bi.text.slice(0, 120).replace(/\s+/g, " ")}` : ""}`);
  }

  // ---- 대안 경로 ----
  console.log("\n--- 대안 경로: data.krx.co.kr 개별종목 PER/PBR/배당수익률(MDCSTAT03501, POST) ---");
  const snaps = new Map<string, AltSnap>();
  const first = await fetchAlt(ITEM3_DATES[ITEM3_DATES.length - 1]);
  let altWorks = false;
  if (first.snap) {
    altWorks = true;
    snaps.set(first.snap.date, first.snap);
  } else {
    console.log(`대안 경로 사용 불가: ${first.why}`);
  }
  if (altWorks) {
    for (const d of ITEM3_DATES.slice(0, -1)) {
      const r = await fetchAlt(d);
      if (r.snap) snaps.set(d, r.snap); else console.log(`${d}: 조회 실패 — ${r.why}`);
    }
    console.log("| 날짜 | 종목 수 | 응답 필드명 | EPS 결측 % | EPS<=0 % | BPS 결측 % | BPS<=0 % | DPS 결측 % | 응답 크기 | 소요 ms |");
    console.log("|---|---|---|---|---|---|---|---|---|---|");
    for (const d of ITEM3_DATES) {
      const s = snaps.get(d);
      if (!s) { console.log(`| ${d} | 조회 실패 | | | | | | | | |`); continue; }
      const n = s.rows.length;
      const miss = (k: "eps" | "bps" | "dps"): string => f2((s.rows.filter((r) => !Number.isFinite(r[k])).length / n) * 100);
      const nonpos = (k: "eps" | "bps"): string => f2((s.rows.filter((r) => Number.isFinite(r[k]) && r[k] <= 0).length / n) * 100);
      console.log(`| ${d} | ${n} | ${s.fields.join(",")} | ${miss("eps")} | ${nonpos("eps")} | ${miss("bps")} | ${nonpos("bps")} | ${miss("dps")} | ${s.bytes} B | ${s.ms} |`);
    }
  }

  // ---- 항목 5: 회계기준 전환 ----
  console.log("\n=== 항목 5: 회계기준 전환 구간 KRX EPS/BPS (표본 5종목) ===");
  if (!altWorks) {
    console.log("KRX EPS/BPS 응답 경로를 확보하지 못해 측정하지 못했습니다(항목 3 참고).");
  } else {
    for (const d of ITEM5_EXTRA_DATES) {
      const r = await fetchAlt(d);
      if (r.snap) snaps.set(d, r.snap); else console.log(`${d}: 조회 실패 — ${r.why}`);
    }
    const dates5 = ["2010-01-29", "2010-12-30", "2011-01-31", "2011-03-31", "2011-06-30"];
    console.log("| 종목 | " + dates5.map((d) => `${d} EPS / BPS`).join(" | ") + " |");
    console.log("|---|" + dates5.map(() => "---").join("|") + "|");
    for (const c of ITEM5_STOCKS) {
      const cells = dates5.map((d) => {
        const r = snaps.get(d)?.rows.find((x) => x.code === c);
        return r ? `${r.epsRaw} / ${Number.isFinite(r.bps) ? r.bps : "-"}` : snaps.has(d) ? "행 없음" : "조회 안 됨";
      });
      console.log(`| ${c} | ${cells.join(" | ")} |`);
    }
  }

  // ---- 항목 4: 시점 유효성 ----
  console.log("\n=== 항목 4: 시점 유효성 (KRX EPS/BPS vs DART 공시일 기준 순이익·자본) ===");
  if (!altWorks) {
    console.log("KRX EPS/BPS 응답 경로를 확보하지 못해 측정하지 못했습니다(항목 3 참고).");
  } else {
    for (const d of ITEM4_DATES) {
      const r = await fetchAlt(d);
      if (r.snap) snaps.set(d, r.snap); else console.log(`${d}: 조회 실패 — ${r.why}`);
    }
    const rows = (await deps.fundRowsForYear(ITEM4_FISCAL_YEAR, ITEM4_RCEPT_FROM, ITEM4_RCEPT_TO)).sort((a, b) => a.rcept_date.localeCompare(b.rcept_date) || a.stock_code.localeCompare(b.stock_code));
    console.log(`FY${ITEM4_FISCAL_YEAR} 공시일 ${ITEM4_RCEPT_FROM}~${ITEM4_RCEPT_TO} 후보 ${rows.length}종목에서 공시일 순으로 균등 간격 ${ITEM4_SAMPLE_SIZE}개 표본 추출`);
    const sample: FundRow[] = [];
    if (rows.length <= ITEM4_SAMPLE_SIZE) sample.push(...rows);
    else for (let i = 0; i < ITEM4_SAMPLE_SIZE; i++) sample.push(rows[Math.floor((i * rows.length) / ITEM4_SAMPLE_SIZE)]);
    const [d0, d1, d2] = ITEM4_DATES;
    const get = (d: string, c: string): AltRow | undefined => snaps.get(d)?.rows.find((x) => x.code === c);
    console.log("| 종목 | DART 공시일 | KRX EPS 02-28 | 03-30 | 05-31 | 변경 구간 | 공시일 대비 | KRX BPS/EPS ÷ DART 자본/순이익 − 1 (05-31) |");
    console.log("|---|---|---|---|---|---|---|---|");
    let earlier = 0, inWindowAfter = 0, laterChange = 0, noChange = 0, missing = 0;
    const diffs: number[] = [], lowers: number[] = [], uppers: number[] = [];
    for (const s of sample) {
      const a = get(d0, s.stock_code), b = get(d1, s.stock_code), c = get(d2, s.stock_code);
      if (!a || !b || !c || !Number.isFinite(a.eps) || !Number.isFinite(b.eps) || !Number.isFinite(c.eps)) { missing++; console.log(`| ${s.stock_code} | ${s.rcept_date} | ${a?.epsRaw ?? "-"} | ${b?.epsRaw ?? "-"} | ${c?.epsRaw ?? "-"} | 판정 불가(결측) | - | - |`); continue; }
      let where = "변경 없음", rel = "-";
      if (a.eps !== b.eps) {
        where = `${d0}→${d1}`;
        if (s.rcept_date > d1) { earlier++; rel = "공시일보다 먼저 변경"; } else { inWindowAfter++; rel = `공시일(${s.rcept_date}) 이후/같은 구간`; }
        lowers.push(dayDiff(s.rcept_date, d0)); uppers.push(dayDiff(s.rcept_date, d1));
      } else if (b.eps !== c.eps) {
        where = `${d1}→${d2}`; laterChange++; rel = s.rcept_date <= d1 ? "공시 후 구간 밖에서 변경" : "공시일 이후 변경";
        lowers.push(dayDiff(s.rcept_date, d1)); uppers.push(dayDiff(s.rcept_date, d2));
      } else noChange++;
      let diff = NaN;
      if (s.net_income_parent && s.equity_parent && s.net_income_parent !== 0 && Number.isFinite(c.bps) && c.eps !== 0) {
        diff = (c.bps / c.eps) / (s.equity_parent / s.net_income_parent) - 1;
        diffs.push(diff);
      }
      console.log(`| ${s.stock_code} | ${s.rcept_date} | ${a.epsRaw} | ${b.epsRaw} | ${c.epsRaw} | ${where} | ${rel} | ${Number.isFinite(diff) ? f2(diff * 100) + "%" : "-"} |`);
    }
    console.log(`요약(표본 ${sample.length}): 공시일보다 먼저 변경 ${earlier} | 02-28~03-30 구간 변경(공시일 이후/같은 구간) ${inWindowAfter} | 03-30~05-31 구간 변경 ${laterChange} | 변경 없음 ${noChange} | 판정 불가 ${missing}`);
    console.log(`변경 구간 기준 (KRX 변경일 − DART 공시일) 일수 범위: 하한 중앙값 ${f2(pct(lowers, 50))}, 상한 중앙값 ${f2(pct(uppers, 50))} (스냅샷 해상도 한계로 구간 범위만 알 수 있음)`);
    console.log(`값 차이 비율(%) 분포(n=${diffs.length}) 5%/50%/95%/최소/최대: ${[5, 50, 95].map((p) => f2(pct(diffs, p) * 100)).join(" / ")} / ${f2(Math.min(...diffs) * 100)} / ${f2(Math.max(...diffs) * 100)}`);
  }

  console.log(`\n외부 요청 사용: ${used}/${EXTERNAL_REQUEST_BUDGET}건`);
  console.log("외부 요청 로그:");
  for (const l of reqLog) console.log(`  ${l}`);
  console.log("\n완료");
}

async function main(): Promise<void> {
  const dartKey = process.env.DART_API_KEY, krxKey = process.env.KRX_API_KEY;
  if (!dartKey || !krxKey) throw new Error("DART_API_KEY / KRX_API_KEY 환경변수가 필요합니다.");
  console.log(`재무 데이터 2010~ 확보 가능성 점검 시작(읽기 전용): ${new Date().toISOString()}`);
  await runProbe({
    dartKey, krxKey,
    corpCode: async (stockCode) => {
      const { data, error } = await supabaseAdmin.from("dart_corp_codes").select("corp_code").eq("stock_code", stockCode).limit(1);
      if (error) throw new Error(error.message);
      return data?.[0]?.corp_code ?? null;
    },
    fundRowsForYear: async (fiscalYear, from, to) => {
      const { data, error } = await supabaseAdmin.from("stock_annual_fundamentals")
        .select("stock_code, rcept_date, net_income_parent, equity_parent, fs_div")
        .eq("fiscal_year", fiscalYear).gte("rcept_date", from).lte("rcept_date", to).order("stock_code").limit(2000);
      if (error) throw new Error(error.message);
      return (data ?? []).map((r) => ({ stock_code: r.stock_code, rcept_date: r.rcept_date, net_income_parent: r.net_income_parent === null ? null : Number(r.net_income_parent), equity_parent: r.equity_parent === null ? null : Number(r.equity_parent), fs_div: r.fs_div }));
    },
  });
}
if (process.argv[1] && process.argv[1].endsWith("probe-fundamentals-2010.ts")) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
