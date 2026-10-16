import AdmZip from "adm-zip";
import { runProbe } from "./probe-dart-xbrl-2nd";

function inst(fy: number, ni: number, eqv: number, cons = true): string {
  const dim = cons ? `<xbrli:scenario><xbrldi:explicitMember dimension="ifrs:ConsolidatedAndSeparateFinancialStatementsAxis">dart:ConsolidatedMember</xbrldi:explicitMember></xbrli:scenario>` : "";
  return `<xbrli:xbrl xmlns:xbrli="x" xmlns:ifrs="y" xmlns:dart="z" xmlns:xbrldi="w">
<xbrli:context id="d1"><xbrli:entity/><xbrli:period><xbrli:startDate>${fy}-01-01</xbrli:startDate><xbrli:endDate>${fy}-12-31</xbrli:endDate></xbrli:period>${dim}</xbrli:context>
<xbrli:context id="d0"><xbrli:entity/><xbrli:period><xbrli:startDate>${fy - 1}-01-01</xbrli:startDate><xbrli:endDate>${fy - 1}-12-31</xbrli:endDate></xbrli:period>${dim}</xbrli:context>
<xbrli:context id="i1"><xbrli:entity/><xbrli:period><xbrli:instant>${fy}-12-31</xbrli:instant></xbrli:period>${dim}</xbrli:context>
<xbrli:context id="i0"><xbrli:entity/><xbrli:period><xbrli:instant>${fy - 1}-12-31</xbrli:instant></xbrli:period>${dim}</xbrli:context>
<ifrs:ProfitLossAttributableToOwnersOfParent contextRef="d1" unitRef="KRW" decimals="-3">${ni}</ifrs:ProfitLossAttributableToOwnersOfParent>
<ifrs:ProfitLossAttributableToOwnersOfParent contextRef="d0" unitRef="KRW" decimals="-3">${ni - 5}</ifrs:ProfitLossAttributableToOwnersOfParent>
<ifrs:EquityAttributableToOwnersOfParent contextRef="i1" unitRef="KRW" decimals="-3">${eqv}</ifrs:EquityAttributableToOwnersOfParent>
<ifrs:EquityAttributableToOwnersOfParent contextRef="i0" unitRef="KRW" decimals="-3">${eqv - 7}</ifrs:EquityAttributableToOwnersOfParent>
<ifrs:BasicEarningsLossPerShare contextRef="d1" unitRef="KRW" decimals="0">10</ifrs:BasicEarningsLossPerShare>
<dart:NumberOfSharesIssued contextRef="i1" unitRef="shares" decimals="0">100</dart:NumberOfSharesIssued>
</xbrli:xbrl>`;
}
const lab = `<link:linkbase><link:loc xlink:href="x.xsd#ifrs_ProfitLossAttributableToOwnersOfParent" xlink:label="L1"/><link:label xlink:label="T1" xlink:role="http://www.xbrl.org/2003/role/label" xml:lang="ko">지배기업 소유주 귀속 당기순이익</link:label><link:labelArc xlink:from="L1" xlink:to="T1"/></link:linkbase>`;
function zipOf(fy: number, ni: number, eqv: number): Buffer {
  const z = new AdmZip(); z.addFile("a.xbrl", Buffer.from(inst(fy, ni, eqv))); z.addFile("labels\\lab_x-ko.xml", Buffer.from(lab)); return z.toBuffer();
}
globalThis.fetch = (async (u: string) => {
  const url = String(u);
  if (url.includes("list.json")) {
    const corp = /corp_code=(\w+)/.exec(url)![1];
    const l = [2011, 2012, 2013, 2014, 2015].flatMap((y) => [{ report_nm: `사업보고서 (${y}.12)`, rcept_no: `${y + 1}03${corp.slice(-4)}01`, rcept_dt: `${y + 1}0330` }, ...(y === 2011 ? [{ report_nm: `[기재정정]사업보고서 (${y}.12)`, rcept_no: `${y + 1}04${corp.slice(-4)}02`, rcept_dt: `${y + 1}0420` }] : [])]);
    return new Response(JSON.stringify({ status: "000", list: l }));
  }
  if (url.includes("fnlttXbrl")) {
    const rc = /rcept_no=(\d+)/.exec(url)![1];
    const y = Number(rc.slice(0, 4)) - 1;
    if (rc.endsWith("99")) return new Response("<result><status>014</status><message>없음</message></result>");
    return new Response(new Uint8Array(zipOf(y, 1000 + y, 5000 + y)));
  }
  if (url.includes("fnlttSinglAcntAll")) return new Response(JSON.stringify({ status: "000", list: [{ rcept_no: "20160301", sj_div: "IS", account_id: "ifrs-full_ProfitLossAttributableToOwnersOfParent", thstrm_amount: "3015" }, { rcept_no: "20160301", sj_div: "BS", account_id: "ifrs-full_EquityAttributableToOwnersOfParent", thstrm_amount: "7015" }] }));
  return new Response("{}", { status: 404 });
}) as typeof fetch;
const mk = (code: string, mcap: number) => Array.from({ length: 40 }, (_, i) => ({ stockCode: code, tradeDate: new Date(Date.UTC(2012, 0, 2 + i)).toISOString().slice(0, 10), closePrice: 1, openPrice: 1, highPrice: 1, lowPrice: 1, volume: 1, tradingValue: 1e10, marketCapEok: mcap, listedShares: 1 }));
const series = new Map<string, any[]>();
const names = new Map<string, { corp_code: string; corp_name: string }>();
for (let i = 0; i < 120; i++) { const c = String(100000 + i); series.set(c, mk(c, 6000 + i * 100)); names.set(c, { corp_code: "00" + c, corp_name: i % 9 === 0 ? `X${i}은행` : `N${i}` }); }
for (const c of ["005930", "053000", "000830"]) { series.set(c, mk(c, 9e5)); names.set(c, { corp_code: "00" + c, corp_name: "T" + c }); }
runProbe({ dartKey: "k", series: series as never, dbCorp: async (codes) => ({ rows: codes.length, map: new Map(codes.filter((c) => names.has(c)).map((c) => [c, names.get(c)!])) }) }).then(() => console.log("mock 종료"));
