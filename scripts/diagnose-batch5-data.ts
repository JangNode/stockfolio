/**
 * [임시 진단 — 병합 금지, 시험 아님, 읽기 전용, 외부 요청 0건] 묶음 5(PF1 우선주 괴리, BS1 전 종목) 사전 조건 확인: 받아 둔 가격 Parquet(고정 스냅샷)·월말 시장 구분표에 필요한 자료가 있는지 센다.
 * 공시(DART) 사용 없음, 연구 DB 쓰기 0, Storage 쓰기 0, KIS·KRX 호출 0. 결과는 요약만 출력한다.
 */
import { loadHarness, loadK200P, verifySnapshotManifest, dbRead, storageLine, f2, median } from "./researchHarness";

async function main(): Promise<void> {
  console.log(await verifySnapshotManifest());
  const h = await loadHarness();
  const { CAL, nCal, stocks, byCode } = h;
  const { membAt, mmDates, nameOf, excluded } = await loadK200P(h);
  const lastIdx = (s: { dates: string[] }): string => s.dates[s.dates.length - 1];
  console.log(`\n=== 1. 종목 수·코드 끝자리·폐지 ===\n전체 ${stocks.length}종목, 달력 ${nCal}일 ${CAL[0]}~${CAL[nCal - 1]}, 폐지(마지막 행 < ${h.endedBefore}) ${stocks.filter((s) => lastIdx(s) < h.endedBefore).length}종목`);
  const dig = new Map<string, number>(), digDel = new Map<string, number>();
  for (const s of stocks) { const d = s.code[s.code.length - 1]; dig.set(d, (dig.get(d) ?? 0) + 1); if (lastIdx(s) < h.endedBefore) digDel.set(d, (digDel.get(d) ?? 0) + 1); }
  console.log(`끝자리별 종목 수(그중 폐지): ${[...dig].sort().map(([d, n]) => `${d}: ${n}(${digDel.get(d) ?? 0})`).join(" | ")}`);

  console.log(`\n=== 2. 우선주(코드 끝자리 5) 짝 ===`);
  const prefs = stocks.filter((s) => s.code[s.code.length - 1] === "5");
  const pairs = prefs.map((p) => ({ p, c: byCode.get(p.code.slice(0, 5) + "0") })).filter((x) => x.c);
  console.log(`끝자리 5 종목 ${prefs.length}개, 앞 5자리가 같은 끝자리 0 종목이 있는 짝 ${pairs.length}개, 짝 없는 우선주 ${prefs.length - pairs.length}개(예: ${prefs.filter((p) => !byCode.has(p.code.slice(0, 5) + "0")).slice(0, 5).map((p) => `${p.code} ${nameOf.get(p.code) ?? ""}`).join(", ")})`);
  const pairStats = pairs.map(({ p, c }) => {
    let valid = 0, tvPos = 0, volPos = 0;
    for (let i = 0; i < p.dates.length; i++) if (p.dates[i] >= "2011-01-01") { valid++; if (p.tv[i] > 0) tvPos++; if (p.vol[i] > 0) volPos++; }
    return { code: p.code, name: nameOf.get(p.code) ?? "", first: p.dates[0], last: lastIdx(p), valid, tvPos, volPos, cFirst: c!.dates[0], del: lastIdx(p) < h.endedBefore };
  });
  const since2010 = pairStats.filter((x) => x.first <= "2010-02-01");
  console.log(`짝 ${pairs.length}개 중 2010-02-01 이전부터 행이 있는 짝 ${since2010.length}개, 폐지된 짝 ${pairStats.filter((x) => x.del).length}개, 거래대금 열이 양수인 날 비율(2011~, 우선주 전체) ${f2((pairStats.reduce((a, x) => a + x.tvPos, 0) / Math.max(pairStats.reduce((a, x) => a + x.valid, 0), 1)) * 100)}%`);
  const yrs: string[] = [];
  for (let y = 2011; y <= 2026; y++) {
    const d = CAL.filter((x) => x.startsWith(String(y))); const c = d[d.length - 1];
    const m = membAt(c);
    let nPair = 0, nPairMemberKospi = 0, nPrefInMm = 0, nTv5 = 0;
    for (const { p, c: cs } of pairs) {
      const ip = p.idx.get(c), ic = cs!.idx.get(c);
      if (ip !== undefined && ic !== undefined && p.vol[ip] > 0 && cs!.vol[ic] > 0) { nPair++; if (m?.get(cs!.code) === "KOSPI") nPairMemberKospi++; let s = 0, n = 0; for (let k = ip; k >= 0 && n < 60; k--, n++) s += p.tv[k]; if (s / Math.max(n, 1) >= 5e8) nTv5++; }
    }
    if (m) for (const [code] of m) if (code[code.length - 1] === "5") nPrefInMm++;
    yrs.push(`${c}: 연말 거래 중인 짝 ${nPair}(보통주 코스피 ${nPairMemberKospi}, 우선주 60일 평균 거래대금 ≥ 5억 ${nTv5}) / 월말 시장표 끝자리 5 ${nPrefInMm}`);
  }
  console.log(yrs.join("\n"));
  console.log(`월말 시장표 종목 수 예시: ${["2011-12-29", "2016-12-29", "2021-12-30", "2026-10-23"].map((d) => { const m = membAt(d); let k = 0, q = 0; if (m) for (const [, v] of m) { if (v === "KOSPI") k++; else if (v === "KOSDAQ") q++; } return `${d} 코스피 ${k} 코스닥 ${q}`; }).join(" | ")}; 월말 표 날짜 ${mmDates[0]}~${mmDates[mmDates.length - 1]} (${mmDates.length}개)`);

  console.log(`\n=== 3. 전 종목(코스피+코스닥) 가격 자료 범위 ===`);
  for (const d of ["2011-12-29", "2016-12-29", "2021-12-30", "2026-10-23"]) {
    const m = membAt(d); let k = 0, q = 0, kPrice = 0, qPrice = 0, tvMiss = 0, mcMiss = 0, vol0 = 0;
    if (m) for (const [code, v] of m) {
      const s = byCode.get(code); const i = s?.idx.get(d);
      if (v === "KOSPI") k++; else if (v === "KOSDAQ") q++;
      if (s && i !== undefined) { if (v === "KOSPI") kPrice++; else if (v === "KOSDAQ") qPrice++; if (!(s.tv[i] > 0)) tvMiss++; if (!(s.mcapRow[i] > 0)) mcMiss++; if (s.vol[i] === 0) vol0++; }
    }
    console.log(`${d}: 시장표 코스피 ${k}/가격 있음 ${kPrice}, 코스닥 ${q}/가격 있음 ${qPrice} | 가격 행 중 거래대금 0 ${tvMiss}, 시총 0 ${mcMiss}, 거래량 0 ${vol0}`);
  }
  const lastYear = new Map<string, number>();
  for (const s of stocks) { if (lastIdx(s) < h.endedBefore) { const y = lastIdx(s).slice(0, 4); lastYear.set(y, (lastYear.get(y) ?? 0) + 1); } }
  console.log(`폐지(마지막 행) 연도별 종목 수: ${[...lastYear].sort().map(([y, n]) => `${y} ${n}`).join(" ")}`);
  const exc = stocks.filter((s) => excluded.has(s.code)).length;
  console.log(`제외 규칙(4c1557a: 우선주·ETF·스팩·리츠) 해당 ${exc}종목`);
  const gaps = stocks.filter((s) => lastIdx(s) < h.endedBefore).map((s) => { const k = CAL.indexOf(lastIdx(s)); return k >= 0 ? s.dates.length : 0; });
  console.log(`폐지 종목 행 수 중앙값 ${median(gaps)}`);
  console.log(`\nSupabase 읽은 행: ${Object.entries(dbRead).map(([k, v]) => `${k} ${v}`).join(" | ")} | ${storageLine()} | 쓰기 0 | 외부 요청 0 | DART 0`);
}
main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });
