import AdmZip from "adm-zip";
import { runProbe, parseXbrlZip } from "./probe-dart-xbrl-2010";
const xml = `<?xml version="1.0"?><xbrli:xbrl xmlns:xbrli="x" xmlns:ifrs-full="y" xmlns:dart="z"><link:schemaRef xlink:href="http://dart.fss.or.kr/xbrl/ifrs.xsd"/>
<xbrli:context id="c1"><xbrli:entity/><xbrli:period><xbrli:startDate>2010-01-01</xbrli:startDate><xbrli:endDate>2010-12-31</xbrli:endDate></xbrli:period></xbrli:context>
<xbrli:context id="c2"><xbrli:entity/><xbrli:period><xbrli:instant>2010-12-31</xbrli:instant></xbrli:period></xbrli:context>
<ifrs-full:ProfitLossAttributableToOwnersOfParent contextRef="c1" unitRef="KRW" decimals="-3">1234000</ifrs-full:ProfitLossAttributableToOwnersOfParent>
<ifrs-full:EquityAttributableToOwnersOfParent contextRef="c2" unitRef="KRW" decimals="-3">99999000</ifrs-full:EquityAttributableToOwnersOfParent></xbrli:xbrl>`;
const z = new AdmZip(); z.addFile("a.xbrl", Buffer.from(xml)); z.addFile("b.xsd", Buffer.from("x"));
const zb = z.toBuffer();
console.log(JSON.stringify(parseXbrlZip(zb)));
const dz = new AdmZip(); dz.addFile("doc.xml", Buffer.from("<TABLE>재무상태표 한국채택국제회계기준</TABLE>")); const db = dz.toBuffer();
globalThis.fetch = (async (u: string) => {
  const url = String(u);
  if (url.includes("list.json")) {
    const corp = /corp_code=(\w+)/.exec(url)![1];
    return new Response(JSON.stringify({ status: "000", message: "정상", total_count: 3, list: [2010, 2011, 2012].map((y) => ({ report_nm: `사업보고서 (${y}.12)`, rcept_no: `${y + 1}0315${corp.slice(-3)}`, rcept_dt: `${y + 1}0315` })) }));
  }
  if (url.includes("fnlttXbrl")) return url.includes("20110315") ? new Response(new Uint8Array(zb)) : new Response("<result><status>013</status><message>no data</message></result>");
  if (url.includes("document.xml")) return new Response(new Uint8Array(db));
  return new Response("{}", { status: 404 });
}) as typeof fetch;
const mk = (code: string, last: string, mcap: number) => [{ stockCode: code, tradeDate: "2010-01-29", closePrice: 1, openPrice: 1, highPrice: 1, lowPrice: 1, volume: 1, tradingValue: 1e10, marketCapEok: mcap, listedShares: 1 }, { stockCode: code, tradeDate: last, closePrice: 1, openPrice: 1, highPrice: 1, lowPrice: 1, volume: 1, tradingValue: 1e10, marketCapEok: mcap, listedShares: 1 }];
const series = new Map<string, any[]>([["005930", mk("005930", "2016-12-30", 9e5)], ["111111", mk("111111", "2014-05-02", 7000)], ["222222", mk("222222", "2015-06-02", 800)], ["333333", mk("333333", "2016-12-30", 6000)]]);
runProbe({
  dartKey: "k", series: series as never,
  dbCorp: async (codes) => ({ rows: 3, map: new Map(codes.filter((c) => c !== "333333").map((c) => [c, { corp_code: "00" + c, corp_name: "N" + c }])) }),
  kis: { income: async (c) => (c === "111111" ? Promise.reject(new Error("no data")) : [{ year: 2012, netIncome: 1 }, { year: 2013, netIncome: 2 }]), balance: async () => [{ year: 2013, totalEquity: 1 }], price: async () => ({ eps: 1, bps: 2, per: 3, pbr: 4 }) },
}).then(() => console.log("mock 종료"));
