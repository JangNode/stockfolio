/**
 * [임시 연구 — 병합 금지, 읽기 전용, 저장 없음] 분기 실적 데이터 확보 가능성 점검.
 * DART 외부 요청 총 40건 이하(재시도 없음, 초과 시 중단), KIS 0건, Supabase는 REST 읽기만.
 * 숫자와 표만 출력한다. 판정·추천 없음.
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadAllStockSeriesFromParquet } from "@/lib/stockDailyPricesStorage";
import { parseInst } from "@/lib/dartXbrlExtract";

const T0 = Date.now();
const DART_BASE_URL = "https://opendart.fss.or.kr/api";
const DART_REQUEST_CAP = 40;
const DART_GAP_MS = 200;
const DART_ITEM1_CAP = 38; // 항목 3(list.json 1건 + fnlttXbrl 1건)용 2건은 항목 1이 쓰지 못하게 남겨 둔다
const FIXED = ["005930", "000660"];
const MID_TARGET_MCAP_EOK = 10_000; // 시총 중형 선정: 2018년 말 시총이 1조원에 가장 가까운 종목
const DELIST_LAST_FROM = "2019-12-01", DELIST_LAST_TO = "2020-12-31";
const FYS = [2015, 2018, 2024];
const REPORTS: { code: string; name: string; qEnd: (fy: number) => string }[] = [
  { code: "11013", name: "1분기", qEnd: (fy) => `${fy}-03-31` },
  { code: "11012", name: "반기", qEnd: (fy) => `${fy}-06-30` },
  { code: "11014", name: "3분기", qEnd: (fy) => `${fy}-09-30` },
];
const QUOTA_PER_DAY = 20_000;
const MS_DAY = 86_400_000;
const dbRead: Record<string, number> = {};
let dartRequests = 0;
let lastReq = 0;

async function selectAll<T>(label: string, build: (f: number, t: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from, from + 999);
    if (error) throw new Error(`${label}: ${error.message}`);
    out.push(...(data ?? []));
    dbRead[label] = (dbRead[label] ?? 0) + (data?.length ?? 0);
    if ((data?.length ?? 0) < 1000) break;
  }
  return out;
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function dartGet(url: string, cap = DART_REQUEST_CAP): Promise<Buffer | null> {
  if (dartRequests >= cap) return null;
  const wait = lastReq + DART_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastReq = Date.now();
  dartRequests++;
  try {
    return Buffer.from(await (await fetch(url)).arrayBuffer());
  } catch (e) {
    console.log(`  (요청 실패: ${e instanceof Error ? e.message : String(e)})`);
    return null;
  }
}
const dateOfRcept = (r: string): string => `${r.slice(0, 4)}-${r.slice(4, 6)}-${r.slice(6, 8)}`;
const dayDiff = (a: string, b: string): number => Math.round((Date.parse(b) - Date.parse(a)) / MS_DAY);

interface AcntRow { rcept_no?: string; reprt_code?: string; bsns_year?: string; sj_div?: string; sj_nm?: string; account_id?: string; account_nm?: string; thstrm_nm?: string; thstrm_amount?: string; thstrm_add_amount?: string; frmtrm_nm?: string; frmtrm_amount?: string; frmtrm_q_nm?: string; frmtrm_q_amount?: string; frmtrm_add_amount?: string }
const isNiRow = (r: AcntRow): boolean => /ProfitLoss/i.test(r.account_id ?? "") || /(지배|소유주).*(순이익|순손익)|(순이익|순손익).*(지배|소유주)|^(분기|반기|당기)순(이익|손익)/.test(r.account_nm ?? "");

async function main(): Promise<void> {
  const key = process.env.DART_API_KEY;
  if (!key) throw new Error("DART_API_KEY 환경변수가 필요합니다.");
  console.log(`분기 실적 데이터 확보 가능성 점검(읽기 전용): ${new Date().toISOString()}`);

  // ---- 대상 종목 선정(가격 Parquet + DB 읽기) ----
  const series = await loadAllStockSeriesFromParquet(2018, new Date().getUTCFullYear(), new Map());
  const funds = await selectAll<{ stock_code: string; fiscal_year: number; net_income_parent: number | null; fs_div: string; rcept_date: string }>("stock_annual_fundamentals", (f, t) => supabaseAdmin.from("stock_annual_fundamentals").select("stock_code, fiscal_year, net_income_parent, fs_div, rcept_date").order("stock_code").order("fiscal_year").range(f, t));
  const fyBy = new Map<string, Map<number, { ni: number | null; fs: string; rcept: string }>>();
  for (const r of funds) {
    if (!fyBy.has(r.stock_code)) fyBy.set(r.stock_code, new Map());
    fyBy.get(r.stock_code)!.set(r.fiscal_year, { ni: r.net_income_parent === null ? null : Number(r.net_income_parent), fs: r.fs_div, rcept: r.rcept_date });
  }
  const corps = await selectAll<{ corp_code: string; corp_name: string; stock_code: string | null }>("dart_corp_codes", (f, t) => supabaseAdmin.from("dart_corp_codes").select("corp_code, corp_name, stock_code").not("stock_code", "is", null).order("corp_code").range(f, t));
  const corpBy = new Map<string, { corp: string; name: string }>();
  for (const c of corps) if (c.stock_code && !corpBy.has(c.stock_code)) corpBy.set(c.stock_code, { corp: c.corp_code, name: c.corp_name });
  let globalLast = "";
  const info = new Map<string, { last: string; mcap2018: number | null; lastMcap: number }>();
  for (const [code, rows] of series) {
    const last = rows[rows.length - 1];
    if (last.tradeDate > globalLast) globalLast = last.tradeDate;
    let m18: number | null = null;
    for (let i = rows.length - 1; i >= 0; i--) if (rows[i].tradeDate <= "2018-12-31") { m18 = rows[i].marketCapEok; break; }
    info.set(code, { last: last.tradeDate, mcap2018: m18, lastMcap: last.marketCapEok });
  }
  const aliveCut = new Date(Date.parse(globalLast) - 14 * MS_DAY).toISOString().slice(0, 10);
  const hasFy = (c: string, ys: number[]): boolean => ys.every((y) => fyBy.get(c)?.get(y)?.ni != null);
  const mids = [...info.entries()].filter(([c, v]) => !FIXED.includes(c) && corpBy.has(c) && v.last >= aliveCut && v.mcap2018 !== null && v.mcap2018 > 0 && hasFy(c, FYS)).sort((a, b) => Math.abs(a[1].mcap2018! - MID_TARGET_MCAP_EOK) - Math.abs(b[1].mcap2018! - MID_TARGET_MCAP_EOK));
  const dels = [...info.entries()].filter(([c, v]) => corpBy.has(c) && v.last >= DELIST_LAST_FROM && v.last <= DELIST_LAST_TO && hasFy(c, [2015, 2018])).sort((a, b) => b[1].lastMcap - a[1].lastMcap);
  if (!mids.length || !dels.length) { console.log(`대상 선정 실패: 중형 후보 ${mids.length}, 상장폐지 후보 ${dels.length}`); return; }
  const mid = mids[0][0], del = dels[0][0];
  console.log(`종목 후보: 중형 ${mids.length}개 중 선정, 상장폐지(마지막 거래일 ${DELIST_LAST_FROM}~${DELIST_LAST_TO}, FY2015·FY2018 순이익 있음) ${dels.length}개 중 선정`);
  const targets = [...FIXED, mid, del];
  console.log("| 구분 | 종목코드 | 회사명 | corp_code | 마지막 거래일 | 2018말 시총(억) | 연간 FY2018 순이익(DB) |");
  console.log("|---|---|---|---|---|---|---|");
  const labels = ["대형", "대형", "중형", "상장폐지"];
  targets.forEach((c, i) => {
    const v = info.get(c);
    console.log(`| ${labels[i]} | ${c} | ${corpBy.get(c)?.name ?? "-"} | ${corpBy.get(c)?.corp ?? "-"} | ${v?.last ?? "-"} | ${v?.mcap2018?.toFixed(0) ?? "-"} | ${fyBy.get(c)?.get(2018)?.ni ?? "-"} (${fyBy.get(c)?.get(2018)?.fs ?? "-"}) |`);
  });

  // ---- 1. 분기·반기 fnlttSinglAcntAll ----
  console.log("\n=== 1. fnlttSinglAcntAll 요청 결과 ===");
  console.log("| 종목 | FY | 보고서 | fs_div | status | 행 수 | rcept_no | 접수일 | 분기말 | 분기말→접수 일수 |");
  console.log("|---|---|---|---|---|---|---|---|---|---|");
  const niLines: string[] = [];
  const q3Cum = new Map<string, string>();
  let ofsFallbacks = 0, skipped = 0;
  for (const code of targets) {
    const corp = corpBy.get(code)!.corp;
    for (const fy of FYS) {
      if (code === del && !(fy === 2015 || fy === 2018)) { skipped += REPORTS.length; continue; }
      for (const rp of REPORTS) {
        let used = "CFS";
        let json: { status?: string; list?: AcntRow[] } | null = null;
        for (const fs of ["CFS", "OFS"]) {
          used = fs;
          const buf = await dartGet(`${DART_BASE_URL}/fnlttSinglAcntAll.json?crtfc_key=${key}&corp_code=${corp}&bsns_year=${fy}&reprt_code=${rp.code}&fs_div=${fs}`, DART_ITEM1_CAP);
          if (!buf) { json = null; break; }
          try { json = JSON.parse(buf.toString("utf-8")); } catch { json = null; break; }
          if (json?.status === "013" && fs === "CFS") { ofsFallbacks++; continue; }
          break;
        }
        const rows = json?.list ?? [];
        const rcept = rows[0]?.rcept_no ?? "";
        const qEnd = rp.qEnd(fy);
        console.log(`| ${code} | ${fy} | ${rp.name}(${rp.code}) | ${used} | ${json?.status ?? "요청없음/실패"} | ${rows.length} | ${rcept || "-"} | ${rcept ? dateOfRcept(rcept) : "-"} | ${qEnd} | ${rcept ? dayDiff(qEnd, dateOfRcept(rcept)) : "-"} |`);
        for (const r of rows.filter(isNiRow)) {
          niLines.push(`| ${code} | ${fy} | ${rp.name} | ${r.sj_div} | ${r.account_nm} | ${r.account_id} | ${r.thstrm_nm ?? ""} | ${r.thstrm_amount ?? ""} | ${r.thstrm_add_amount ?? ""} | ${r.frmtrm_q_nm ?? ""}:${r.frmtrm_q_amount ?? ""} | ${r.frmtrm_add_amount ?? ""} |`);
          if (fy === 2018 && rp.code === "11014" && /AttributableToOwnersOfParent/.test(r.account_id ?? "") && r.thstrm_add_amount) q3Cum.set(code, r.thstrm_add_amount);
        }
      }
    }
  }
  console.log(`\n(상장폐지 종목 FY2024 요청 생략 ${skipped}건 — 해당 연도 보고서 없음) | OFS 폴백 ${ofsFallbacks}회`);
  console.log("\n지배기업 소유주 귀속 당기순이익 관련 계정(account_id에 ProfitLoss 포함 또는 이름이 지배/소유주 순이익):");
  console.log("| 종목 | FY | 보고서 | sj_div | account_nm | account_id | thstrm_nm | thstrm_amount | thstrm_add_amount | 전기동분기(frmtrm_q_nm:금액) | frmtrm_add_amount |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const l of niLines) console.log(l);

  // ---- 2. FY2018 4분기 = 연간 − 3분기 누적 ----
  console.log("\n=== 2. FY2018 4분기 = 연간 − 3분기 누적 ===");
  console.log("| 종목 | 연간 순이익(stock_annual_fundamentals, fs_div) | 3분기 누적(thstrm_add_amount, ProfitLossAttributableToOwnersOfParent) | 연간 − 3분기 누적 |");
  console.log("|---|---|---|---|");
  for (const code of targets) {
    const a = fyBy.get(code)?.get(2018);
    const q3 = q3Cum.get(code);
    const annual = a?.ni ?? null;
    const q3n = q3 !== undefined ? Number(q3.replace(/,/g, "")) : null;
    console.log(`| ${code} | ${annual ?? "-"} (${a?.fs ?? "-"}) | ${q3 ?? "-"} | ${annual !== null && q3n !== null && Number.isFinite(q3n) ? annual - q3n : "-"} |`);
  }

  // ---- 3. 005930 FY2013 1분기 fnlttXbrl.xml ----
  console.log("\n=== 3. 005930 FY2013 1분기 fnlttXbrl.xml ===");
  const samsung = corpBy.get("005930")!.corp;
  const lb = await dartGet(`${DART_BASE_URL}/list.json?crtfc_key=${key}&corp_code=${samsung}&bgn_de=20130401&end_de=20130630&pblntf_ty=A&page_no=1&page_count=100`);
  let lj: { status?: string; list?: { report_nm?: string; rcept_no?: string; rcept_dt?: string }[] } | null = null;
  try { lj = lb ? JSON.parse(lb.toString("utf-8")) : null; } catch { lj = null; }
  console.log(`list.json status ${lj?.status ?? "실패"}, 건수 ${lj?.list?.length ?? 0}`);
  for (const x of lj?.list ?? []) console.log(`  ${x.rcept_dt} ${x.rcept_no} ${x.report_nm}`);
  const q1 = (lj?.list ?? []).find((x) => /분기보고서\s*\(2013\.03\)/.test(x.report_nm ?? ""));
  if (!q1?.rcept_no) console.log("2013.03 분기보고서를 list.json에서 찾지 못함 → fnlttXbrl 요청 생략");
  else {
    const xb = await dartGet(`${DART_BASE_URL}/fnlttXbrl.xml?crtfc_key=${key}&rcept_no=${q1.rcept_no}&reprt_code=11013`);
    if (!xb) console.log(`rcept_no ${q1.rcept_no}: 응답 없음`);
    else {
      const zip = xb.length > 4 && xb[0] === 0x50 && xb[1] === 0x4b;
      console.log(`rcept_no ${q1.rcept_no}(${q1.rcept_dt}): 응답 ${xb.length} bytes, zip ${zip}${zip ? "" : ` | 본문 앞 200자: ${xb.toString("utf-8").slice(0, 200).replace(/\s+/g, " ")}`}`);
      if (zip) {
        const p = parseInst(xb);
        if ("error" in p) console.log(`zip 해석 오류: ${p.error}`);
        else {
          const hits = p.facts.filter((f) => f.local === "ProfitLossAttributableToOwnersOfParent");
          console.log(`instance ${p.instance ?? "없음"} | ProfitLossAttributableToOwnersOfParent 팩트 ${hits.length}개 (broad 팩트 총 ${p.facts.length})`);
          console.log("| start | end | 기간(일) | dims | value |");
          console.log("|---|---|---|---|---|");
          for (const f of hits) console.log(`| ${f.start ?? "(instant)"} | ${f.end} | ${f.start ? dayDiff(f.start, f.end) : "-"} | ${f.dims.join(";") || "(없음)"} | ${f.value} |`);
        }
      }
    }
  }

  // ---- 4. 규모 추정 ----
  console.log("\n=== 4. 규모 추정 ===");
  const nStocks = new Set(funds.map((f) => f.stock_code)).size;
  const fyAll = 2026 - 2015 + 1;
  const fullReports = 3 * fyAll;
  const partialReports = 3 * (fyAll - 1) + 2;
  console.log("| 가정 | 종목 수 | 보고서 수/종목 | CFS 1회 요청 수 | OFS 폴백 상한(×2) | 일 한도 20,000 대비 일수(CFS) | 일수(×2) | 저장 행 수(종목×보고서) |");
  console.log("|---|---|---|---|---|---|---|---|");
  for (const [label, per] of [["FY2015~FY2026 전 분기(3종×12년)", fullReports], ["FY2026은 1분기·반기만(3분기 미접수)", partialReports]] as [string, number][]) {
    const req = nStocks * per;
    console.log(`| ${label} | ${nStocks} | ${per} | ${req} | ${req * 2} | ${(req / QUOTA_PER_DAY).toFixed(2)} | ${(req * 2 / QUOTA_PER_DAY).toFixed(2)} | ${req} |`);
  }
  console.log(`(stock_annual_fundamentals 행 ${funds.length}, 종목 ${nStocks}개; 4분기 파생 행은 연간−3분기 누적으로 계산하므로 요청 불필요, 파생 시 FY당 +${nStocks}행)`);

  console.log("\n=== 실행 지표 ===");
  console.log(`Supabase 읽은 행: ${Object.entries(dbRead).map(([k, v]) => `${k} ${v}`).join(" | ")} | 합계 ${Object.values(dbRead).reduce((a, b) => a + b, 0)}`);
  console.log(`Supabase 쓴 행: 0 | DART 요청 수: ${dartRequests} (상한 ${DART_REQUEST_CAP}) | KIS 요청: 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
