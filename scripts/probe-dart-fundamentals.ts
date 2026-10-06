/**
 * 디스포저블 프로브(읽기 전용, DB 쓰기 없음): DART fnlttSinglAcntAll이 연도별로 실제 무엇을 주는지(가장 이른 연도,
 * 지배주주순이익 계정 id 표기, 접수번호/공시일)와 stock_annual_fundamentals의 저장 분포를 확인한다.
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const SAMPLE_STOCKS = ["005930", "000270", "035720"];
const YEARS = [2014, 2015, 2016, 2017, 2018, 2019, 2020];
const ACCOUNT_IDS = ["ifrs-full_ProfitLossAttributableToOwnersOfParent", "ifrs_ProfitLossAttributableToOwnersOfParent"];

interface DartRow {
  account_id?: string;
  account_nm?: string;
  thstrm_amount?: string;
  rcept_no?: string;
}

async function pageCount(): Promise<void> {
  const byYear = new Map<number, { rows: number; ni: number; cfs: number; ofs: number; stocks: Set<string>; minRcept: string; maxRcept: string }>();
  const stocks = new Set<string>();
  let total = 0;
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabaseAdmin
      .from("stock_annual_fundamentals")
      .select("stock_code,fiscal_year,rcept_date,net_income_parent,fs_div")
      .order("stock_code")
      .order("fiscal_year")
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    for (const r of data ?? []) {
      total++;
      stocks.add(r.stock_code);
      const b = byYear.get(r.fiscal_year) ?? { rows: 0, ni: 0, cfs: 0, ofs: 0, stocks: new Set<string>(), minRcept: "9999", maxRcept: "0000" };
      b.rows++;
      if (r.net_income_parent !== null) b.ni++;
      if (r.fs_div === "CFS") b.cfs++;
      else b.ofs++;
      b.stocks.add(r.stock_code);
      if (r.rcept_date < b.minRcept) b.minRcept = r.rcept_date;
      if (r.rcept_date > b.maxRcept) b.maxRcept = r.rcept_date;
      byYear.set(r.fiscal_year, b);
    }
    if (!data || data.length < 1000) break;
  }
  console.log(`[저장 분포] stock_annual_fundamentals ${total}행, ${stocks.size}종목`);
  for (const y of Array.from(byYear.keys()).sort()) {
    const b = byYear.get(y)!;
    console.log(`  FY${y}: ${b.rows}행(${b.stocks.size}종목), 순이익 있음 ${b.ni}, CFS ${b.cfs}/OFS ${b.ofs}, 공시일 ${b.minRcept}~${b.maxRcept}`);
  }
  const { data: runs } = await supabaseAdmin
    .from("stock_data_backfill_runs")
    .select("data_source,started_at,status,total_targets,no_data_ratio,avg_response_time_ms")
    .eq("data_source", "dart_fundamentals")
    .order("started_at", { ascending: false })
    .limit(5);
  console.log(`[최근 backfill 실행 이력] ${JSON.stringify(runs)}`);
}

async function main(): Promise<void> {
  await pageCount();
  const key = process.env.DART_API_KEY;
  if (!key) throw new Error("DART_API_KEY가 없습니다.");
  console.log("\n[DART 프로브] 종목·연도별 fnlttSinglAcntAll(CFS, 사업보고서 11011)");
  for (const code of SAMPLE_STOCKS) {
    const { data } = await supabaseAdmin.from("dart_corp_codes").select("corp_code").eq("stock_code", code).maybeSingle();
    if (!data) {
      console.log(`  ${code}: corp_code 없음`);
      continue;
    }
    for (const year of YEARS) {
      const url = `https://opendart.fss.or.kr/api/fnlttSinglAcntAll.json?crtfc_key=${key}&corp_code=${data.corp_code}&bsns_year=${year}&reprt_code=11011&fs_div=CFS`;
      const started = Date.now();
      try {
        const res = await fetch(url);
        const body = (await res.json()) as { status: string; message?: string; list?: DartRow[] };
        const list = body.list ?? [];
        const ni = list.find((r) => ACCOUNT_IDS.includes(r.account_id ?? ""));
        console.log(
          `  ${code} FY${year}: status ${body.status}${body.status !== "000" ? `(${body.message})` : ""}, 항목 ${list.length}개, ` +
            `지배주주순이익 계정 ${ni ? `${ni.account_id}=${ni.thstrm_amount}` : "없음"}, 접수번호 ${list[0]?.rcept_no ?? "-"}, ${Date.now() - started}ms`
        );
        if (body.status === "020") break;
      } catch (e) {
        console.log(`  ${code} FY${year}: 오류 ${e instanceof Error ? e.message : String(e)}`);
      }
      await new Promise((r) => setTimeout(r, 700));
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
