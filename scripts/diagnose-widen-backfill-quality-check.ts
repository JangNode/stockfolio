// 임시 읽기 전용 조사(2010~2015 시세 수집 타당성). 쓰기 없음.
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { downloadYearPrices } from "@/lib/stockDailyPricesStorage";
import { getDailyPrices } from "@/lib/kis";

const KRX = "https://data-dbg.krx.co.kr/svc/apis/sto";
const KEY = process.env.KRX_API_KEY ?? "";
interface Row { ISU_CD: string; ISU_NM?: string; TDD_CLSPRC: string; ACC_TRDVOL: string; ACC_TRDVAL: string; MKTCAP: string; LIST_SHRS: string }

async function krx(ep: string, d: string): Promise<{ status: number; rows: Row[]; ms: number; err?: string }> {
  const t = Date.now();
  try {
    const r = await fetch(`${KRX}/${ep}?basDd=${d}`, { headers: { AUTH_KEY: KEY } });
    if (!r.ok) return { status: r.status, rows: [], ms: Date.now() - t, err: (await r.text()).slice(0, 120) };
    const b = (await r.json()) as { OutBlock_1?: Row[] };
    return { status: r.status, rows: b.OutBlock_1 ?? [], ms: Date.now() - t };
  } catch (e) { return { status: -1, rows: [], ms: Date.now() - t, err: String(e).slice(0, 120) }; }
}
const both = async (d: string) => {
  const [a, b] = await Promise.all([krx("stk_bydd_trd", d), krx("ksq_bydd_trd", d)]);
  return { rows: [...a.rows, ...b.rows], st: `${a.status}/${b.status}`, ms: Math.max(a.ms, b.ms), err: a.err ?? b.err };
};
const full = (rows: Row[]) => ({
  n: rows.length,
  val: rows.filter((r) => Number(r.ACC_TRDVAL) > 0).length,
  cap: rows.filter((r) => Number(r.MKTCAP) > 0).length,
  shr: rows.filter((r) => Number(r.LIST_SHRS) > 0).length,
});

async function main() {
  console.log("== A. Storage 연도별 파일 크기/내용 ==");
  const { data: files } = await supabaseAdmin.storage.from("stock-daily-prices").list("", { limit: 100 });
  for (const f of files ?? []) console.log(f.name, Math.round(((f.metadata as { size?: number })?.size ?? 0) / 1024), "KB");
  for (const y of [2010, 2011, 2012, 2013, 2014, 2015, 2016]) {
    const rows = await downloadYearPrices(y);
    if (rows.length === 0) { console.log(y, "파일 없음"); continue; }
    const dates = new Set(rows.map((r) => r.tradeDate)), codes = new Set(rows.map((r) => r.stockCode));
    const ds = [...dates].sort();
    console.log(y, JSON.stringify({ rows: rows.length, codes: codes.size, days: dates.size, first: ds[0], last: ds[ds.length - 1],
      withTV: rows.filter((r) => r.tradingValue > 0).length, withVol: rows.filter((r) => r.volume > 0).length, withShr: rows.filter((r) => r.listedShares > 0).length,
      minCapEok: Math.round(Math.min(...rows.map((r) => r.marketCapEok))) }));
  }

  console.log("== B. KRX 일별매매정보 표본일 ==");
  const probe = ["20081230", "20090102", "20091230", "20100104", "20100615", "20110615", "20121228", "20130614", "20141230", "20150612", "20150615", "20260102"];
  const snap: Record<string, Row[]> = {};
  for (const d of probe) {
    const r = await both(d);
    snap[d] = r.rows;
    console.log(d, r.st, r.ms + "ms", JSON.stringify(full(r.rows)), r.err ?? "");
  }

  console.log("== C. 월 단위 표본으로 상장폐지 추이 ==");
  const monthly: string[] = [];
  for (let y = 2010; y <= 2015; y++) for (let m = 1; m <= 12; m++) {
    const dt = new Date(Date.UTC(y, m - 1, 15)); while ([0, 6].includes(dt.getUTCDay())) dt.setUTCDate(dt.getUTCDate() + 1);
    monthly.push(dt.toISOString().slice(0, 10).replaceAll("-", ""));
  }
  const present = new Map<string, { name: string; first: string; last: string; capEok: number }>();
  let tot = 0, cnt = 0;
  for (const d of monthly) {
    const r = await both(d); tot += r.ms; cnt++;
    if (r.rows.length === 0) { console.log("빈 응답", d, r.st, r.err ?? ""); continue; }
    for (const row of r.rows) {
      const cur = present.get(row.ISU_CD);
      const cap = Number(row.MKTCAP) / 1e8;
      if (!cur) present.set(row.ISU_CD, { name: row.ISU_NM ?? "", first: d, last: d, capEok: cap });
      else { cur.last = d; cur.capEok = cap; }
    }
  }
  console.log("월표본 호출당 평균 지연(ms, 2엔드포인트 병렬):", Math.round(tot / cnt));
  const latest = new Set((await both("20260102")).rows.map((r) => r.ISU_CD));
  const lastMonth = monthly[monthly.length - 1];
  const delisted = [...present.entries()].filter(([c]) => !latest.has(c));
  console.log("2010~2015 월표본에 등장한 종목:", present.size, "/ 그중 2026-01-02 현재 없음(상폐·코드변경 포함):", delisted.length);
  const byYear: Record<string, number> = {};
  for (const [, v] of delisted) { const y = v.last.slice(0, 4); byYear[y] = (byYear[y] ?? 0) + 1; }
  console.log("마지막 등장 연도별 건수(2015=이후 상폐 포함):", JSON.stringify(byYear));
  const big = delisted.filter(([, v]) => v.capEok >= 5000).length, big1 = delisted.filter(([, v]) => v.capEok >= 10000).length;
  console.log("상폐 종목 중 마지막 시총 5천억+/1조+:", big, big1);
  const stillAt2015 = delisted.filter(([, v]) => v.last < lastMonth).sort((a, b) => b[1].capEok - a[1].capEok).slice(0, 8);
  console.log("2010~2015 중 사라진 시총 상위:", JSON.stringify(stillAt2015.map(([c, v]) => `${c} ${v.name} ${Math.round(v.capEok)}억 ${v.first}~${v.last}`)));
  const s2010 = snap["20100104"], s2015 = snap["20141230"];
  console.log("2010-01-04 종목 수:", s2010.length, " 시총 5천억+:", s2010.filter((r) => Number(r.MKTCAP) >= 5e11).length, " 2014-12-30:", s2015.length);

  console.log("== D. KIS 일봉(2010~2015) 표본 5종목 ==");
  const liveCodes = ["005930", "035420", "068270"];
  const delCodes = stillAt2015.slice(0, 2).map(([c]) => c);
  for (const code of [...liveCodes, ...delCodes]) {
    try {
      const t = Date.now();
      const rows = await getDailyPrices(code, "D", 4000, "batch");
      const sub = rows.filter((r) => r.date >= "2010-01-01" && r.date <= "2015-12-31");
      console.log(code, delCodes.includes(code) ? "(상폐)" : "(현존)", JSON.stringify({ total: rows.length, in2010_2015: sub.length, first: rows[0]?.date, ms: Date.now() - t }));
    } catch (e) { console.log(code, delCodes.includes(code) ? "(상폐)" : "(현존)", "오류:", String(e).slice(0, 160)); }
  }

  console.log("== E. 가격제한폭 ±15% 구간(2015 상반기, 기존 parquet) 일간 등락 분포 ==");
  const y15 = (await downloadYearPrices(2015)).sort((a, b) => (a.stockCode + a.tradeDate).localeCompare(b.stockCode + b.tradeDate));
  const buckets = { b15_30: 0, b30p: 0, over15_pre: 0 };
  let prev: { c: string; p: number } | null = null; const samples: string[] = [];
  for (const r of y15) {
    if (prev && prev.c === r.stockCode && prev.p > 0) {
      const ratio = r.closePrice / prev.p, pre = r.tradeDate < "2015-06-15";
      const dev = Math.abs(ratio - 1);
      if (pre && dev > 0.155) { buckets.over15_pre++; if (dev < 0.3) buckets.b15_30++; else buckets.b30p++; if (samples.length < 6) samples.push(`${r.stockCode} ${r.tradeDate} x${ratio.toFixed(2)} 주식수x${(r.listedShares).toFixed(0)}`); }
    }
    prev = { c: r.stockCode, p: r.closePrice };
  }
  console.log("2015-06-15 이전 |등락|>15.5% 건수:", JSON.stringify(buckets), "예시:", JSON.stringify(samples));
}
main().catch((e) => { console.error(e); process.exit(1); });
