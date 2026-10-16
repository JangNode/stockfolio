import AdmZip from "adm-zip";
import { runProbe } from "./probe-dart-xbrl-3rd";

function inst(fy: number, mode: string): string {
  const cons = `<xbrli:scenario><xbrldi:explicitMember dimension="ifrs:ConsolidatedAndSeparateFinancialStatementsAxis">ifrs:ConsolidatedMember</xbrldi:explicitMember></xbrli:scenario>`;
  const other = `<xbrli:scenario><xbrldi:explicitMember dimension="ifrs:ComponentsOfEquityAxis">ifrs:RetainedEarningsMember</xbrldi:explicitMember></xbrli:scenario>`;
  const d = mode === "other" ? other : mode === "nodim" ? "" : cons;
  const ni = mode === "nodim" ? "ProfitLoss" : "ProfitLossAttributableToOwnersOfParent";
  const eq = mode === "nodim" ? "Equity" : "EquityAttributableToOwnersOfParent";
  return `<xbrli:xbrl xmlns:xbrli="x" xmlns:ifrs="y" xmlns:xbrldi="w">
<xbrli:context id="d1"><xbrli:entity/><xbrli:period><xbrli:startDate>${fy}-01-01</xbrli:startDate><xbrli:endDate>${fy}-12-31</xbrli:endDate></xbrli:period>${d}</xbrli:context>
<xbrli:context id="d0"><xbrli:entity/><xbrli:period><xbrli:startDate>${fy - 1}-01-01</xbrli:startDate><xbrli:endDate>${fy - 1}-12-31</xbrli:endDate></xbrli:period>${d}</xbrli:context>
<xbrli:context id="i1"><xbrli:entity/><xbrli:period><xbrli:instant>${fy}-12-31</xbrli:instant></xbrli:period>${d}</xbrli:context>
<ifrs:${ni} contextRef="d1" unitRef="KRW" decimals="-6">1000</ifrs:${ni}>
<ifrs:${ni} contextRef="d0" unitRef="KRW" decimals="-6">900</ifrs:${ni}>
<ifrs:${eq} contextRef="i1" unitRef="KRW" decimals="-6">5000</ifrs:${eq}>
<ifrs:BasicEarningsLossPerShare contextRef="d1" unitRef="SHARES" decimals="INF">10</ifrs:BasicEarningsLossPerShare>
</xbrli:xbrl>`;
}
const modeOf = (code: string): string => (Number(code) % 3 === 0 ? "nodim" : Number(code) % 7 === 0 ? "other" : "cons");
globalThis.fetch = (async (u: string) => {
  const url = String(u);
  if (url.includes("list.json")) {
    const corp = /corp_code=(\w+)/.exec(url)![1];
    const years = url.includes("bgn_de=2016") ? [2015, 2016] : [2011, 2012, 2013, 2014];
    return new Response(JSON.stringify({ status: "000", total_count: years.length, total_page: 1, list: years.map((y) => ({ report_nm: `사업보고서 (${y}.12)`, rcept_no: `${y + 1}03${corp.slice(-5)}${corp.slice(-1)}1`, rcept_dt: `${y + 1}0330` })) }));
  }
  if (url.includes("fnlttXbrl")) {
    const rc = /rcept_no=(\d+)/.exec(url)![1];
    if (Number(rc.slice(6, 11)) % 4 === 0) return new Response("<result><status>014</status><message>없음</message></result>");
    const z = new AdmZip(); z.addFile("a.xbrl", Buffer.from(inst(Number(rc.slice(0, 4)) - 1, modeOf(rc.slice(6, 11)))));
    return new Response(new Uint8Array(z.toBuffer()));
  }
  if (url.includes("fnlttSinglAcntAll")) return new Response(JSON.stringify({ status: url.includes("2014") ? "013" : "000", message: "x", list: [{ rcept_no: "1", sj_div: "IS", account_id: "ifrs-full_ProfitLossAttributableToOwnersOfParent", thstrm_amount: "1000" }, { rcept_no: "1", sj_div: "BS", account_id: "ifrs-full_EquityAttributableToOwnersOfParent", thstrm_amount: "5000" }] }));
  return new Response("{}", { status: 404 });
}) as typeof fetch;
const SAMPLE = ["005830", "016360", "000810", "052690", "130960", "001430", "001040", "004020", "105630", "079160", "085620", "068870", "082640", "112040", "170900", "048260", "020000", "053800", "015750", "003240", "003540", "192530", "000370", "108320", "083790", "032190", "005880", "029530", "023160", "038500", "005930", "000660", "035420"];
const mk = (code: string, mcap: number) => Array.from({ length: 40 }, (_, i) => ({ stockCode: code, tradeDate: new Date(Date.UTC(2012, 0, 2 + i)).toISOString().slice(0, 10), closePrice: 1, openPrice: 1, highPrice: 1, lowPrice: 1, volume: 1, tradingValue: 1e10, marketCapEok: mcap, listedShares: 1 }));
const series = new Map<string, any[]>();
const names = new Map<string, { corp_code: string; corp_name: string }>();
SAMPLE.forEach((c, i) => { series.set(c, mk(c, 6000 + i * 100)); names.set(c, { corp_code: "00" + c, corp_name: i % 4 === 0 ? `X${c}증권` : `N${c}` }); });
runProbe({ dartKey: "k", series: series as never, dbCorp: async (codes) => ({ rows: codes.length, map: new Map(codes.filter((c) => names.has(c)).map((c) => [c, names.get(c)!])) }) }).then(() => console.log("mock 종료"));
