// 연구용 읽기 전용 점검: KIS 기간별 시세로 ETF 일별 이력 확인. 저장 없음, KIS 40건 이하.
import { getDailyPricesRangeForResearch, getKisCallStats } from "../lib/kis";

const MAX_KIS_REQUESTS = 40;
const ETFS = ["069500", "114260", "148070", "153130", "132030", "261240"];
const PAGE_ROWS = 100;
const TASK1_START = "20090101";
const TASK1_END = "20100630";
const TASK2_START = "20190101";
const TASK2_END = "20201231";
const RATIO_EPS = 1e-9;

type Row = Record<string, string>;
const t0 = Date.now();

async function page(code: string, s: string, e: string, adj: "0" | "1") {
  if (getKisCallStats().total >= MAX_KIS_REQUESTS) throw new Error("KIS 요청 상한 도달");
  return getDailyPricesRangeForResearch(code, s, e, adj);
}

function prevDay(d: string): string {
  const x = new Date(Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8)));
  x.setUTCDate(x.getUTCDate() - 1);
  return x.toISOString().slice(0, 10).replace(/-/g, "");
}

async function fetchAll(code: string, s: string, e: string, adj: "0" | "1", maxPages: number) {
  const rows: Row[] = [];
  let end = e;
  let first: Awaited<ReturnType<typeof page>> | null = null;
  for (let i = 0; i < maxPages; i++) {
    const r = await page(code, s, end, adj);
    first ??= r;
    const ok = r.output2.filter((x) => x.stck_bsop_date);
    rows.push(...ok);
    if (ok.length < PAGE_ROWS) break;
    end = prevDay(ok[ok.length - 1].stck_bsop_date);
  }
  return { rows, first };
}

async function main() {
  console.log("== 항목 1: 2009-01-01~2010-06-30 ==");
  const maxPages: Record<string, number> = { "069500": 4, "114260": 3 };
  for (const code of ETFS) {
    const adj = await fetchAll(code, TASK1_START, TASK1_END, "0", maxPages[code] ?? 1);
    const raw = await page(code, TASK1_START, TASK1_END, "1");
    const rawRows = raw.output2.filter((x) => x.stck_bsop_date);
    const adjFirstPage = adj.rows.slice(0, PAGE_ROWS);
    const rawMap = new Map(rawRows.map((x) => [x.stck_bsop_date, x.stck_clpr]));
    let diff = 0;
    let compared = 0;
    for (const a of adjFirstPage) {
      const rv = rawMap.get(a.stck_bsop_date);
      if (rv === undefined) continue;
      compared++;
      if (rv !== a.stck_clpr) diff++;
    }
    const oldest = adj.rows.length ? adj.rows[adj.rows.length - 1].stck_bsop_date : "-";
    console.log(
      `${code} adj행수=${adj.rows.length} 최초일=${oldest} 최신일=${adj.rows[0]?.stck_bsop_date ?? "-"} | raw첫페이지행수=${rawRows.length} 비교=${compared} 종가상이=${diff}`
    );
    if (code === ETFS[0]) {
      console.log("output1 키:", Object.keys((adj.first?.output1 as object) ?? {}).join(","));
      console.log("output2 키:", Object.keys(adj.rows[0] ?? {}).join(","));
    }
  }

  console.log("== 항목 2: 2019~2020 수정/원주가 비율 ==");
  for (const code of ["114260", "069500"]) {
    const adj = await fetchAll(code, TASK2_START, TASK2_END, "0", 5);
    const raw = await fetchAll(code, TASK2_START, TASK2_END, "1", 5);
    const rawMap = new Map(raw.rows.map((x) => [x.stck_bsop_date, Number(x.stck_clpr)]));
    const series = adj.rows
      .map((x) => ({ d: x.stck_bsop_date, a: Number(x.stck_clpr), r: rawMap.get(x.stck_bsop_date) }))
      .filter((x) => x.r !== undefined && x.r > 0)
      .sort((p, q) => p.d.localeCompare(q.d));
    console.log(`${code} adj행수=${adj.rows.length} raw행수=${raw.rows.length} 겹침=${series.length} 구간=${series[0]?.d}~${series[series.length - 1]?.d}`);
    let changes = 0;
    let prevRatio: number | null = null;
    for (const s of series) {
      const ratio = s.a / s.r!;
      if (prevRatio !== null && Math.abs(ratio / prevRatio - 1) > RATIO_EPS) {
        changes++;
        console.log(`  비율변화 ${s.d}: ${prevRatio.toFixed(6)} -> ${ratio.toFixed(6)} (${((ratio / prevRatio - 1) * 100).toFixed(4)}%)`);
      }
      prevRatio = ratio;
    }
    if (changes === 0) console.log("  분배금 미반영 (비율 변화 날짜 없음)");
  }

  const st = getKisCallStats();
  console.log(`KIS 요청 시도=${st.total} (재시도 ${st.retried}) 소요=${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((e) => {
  const st = getKisCallStats();
  console.error("실패:", e instanceof Error ? e.message : e, `KIS시도=${st.total}`);
  process.exit(1);
});
