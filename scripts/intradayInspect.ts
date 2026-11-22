/**
 * [임시 연구 — 병합 금지] 분봉 데이터 점검 1단계(집계만, 수익·신호·성과 계산 없음): docs/research/intraday-design.md 1절.
 * 읽기 전용: 분봉 월 파일(Storage research/forward/minute/, Actions 캐시 research-files-v1 경유) + 고정 스냅샷 일봉 + 069500·KOSPI 참고 흐름. 연구 DB 쓰기 0, 외부 호출 0.
 */
import { parquetReadObjects } from "hyparquet";
import { cachedBytes } from "@/lib/researchFileCache";
import { download, io, mib } from "@/lib/forwardCollectKit";
import { FWD_MIN_PREFIX, FWD_PROGRESS_FILE, FWD_MANIFEST_FILE, FWD_TARGETS_FILE, FWD_DAYS_FILE } from "@/lib/forwardDataConfig";
import { loadAllStockSeriesFromParquet } from "@/lib/stockDailyPricesStorage";
import { getIndexPriceSeries } from "@/lib/betaPriceHistoryStorage";
import { mulberry32, f2, avg, median, type Harness } from "./researchHarness";

type Row = { hhmm: number; o: number; h: number; l: number; c: number; v: number; a: number };
const text = (b: ArrayBuffer): string => new TextDecoder().decode(b);
const iso = (d: number): string => { const s = String(d); return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`; };
const mm = (hhmm: number): number => Math.floor(hhmm / 100) * 60 + (hhmm % 100);
const pct = (a: number[], q: number): number => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.min(b.length - 1, Math.floor(q * (b.length - 1)))] : Number.NaN; };
const histo = (m: Map<string, number>, top = 12): string => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([k, v]) => `${k}:${v}`).join(", ");
/** KRX 호가 단위(2023-01 이후 유가증권시장 공통, 원): 가격대별. */
const tickOf = (p: number): number => (p < 2000 ? 1 : p < 5000 ? 5 : p < 20000 ? 10 : p < 50000 ? 50 : p < 200000 ? 100 : p < 500000 ? 500 : 1000);
const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

export async function intradayInspect(h: Harness, label: (c: string) => string, bh: { dates: string[]; ret: number[] }): Promise<void> {
  const readB0 = io.readBytes;
  const tb = await cachedBytes(`${FWD_MIN_PREFIX}/${FWD_TARGETS_FILE}`, () => download(`${FWD_MIN_PREFIX}/${FWD_TARGETS_FILE}`));
  const mb = await cachedBytes(`${FWD_MIN_PREFIX}/${FWD_MANIFEST_FILE}`, () => download(`${FWD_MIN_PREFIX}/${FWD_MANIFEST_FILE}`));
  const pbuf = await cachedBytes(`${FWD_MIN_PREFIX}/${FWD_PROGRESS_FILE}`, () => download(`${FWD_MIN_PREFIX}/${FWD_PROGRESS_FILE}`));
  const dbuf = await cachedBytes(`${FWD_MIN_PREFIX}/${FWD_DAYS_FILE}`, () => download(`${FWD_MIN_PREFIX}/${FWD_DAYS_FILE}`));
  if (!tb || !mb || !pbuf) throw new Error("분봉 targets/manifest/progress가 없다 — 중단");
  const targets = JSON.parse(text(tb)) as { codes: string[]; basis?: string }, manifest = JSON.parse(text(mb)) as { updatedAt: string; files: Record<string, { rows: number; bytes: number }> };
  const progress = JSON.parse(text(pbuf)) as { cursorDate: string | null; stocks: Record<string, { rows: number; days: number; emptyDays: string[]; shortDays: string[] }>; runs: { startedAt: string; requests: number; stop: string | null }[] };
  const calDays = dbuf ? (JSON.parse(text(dbuf)) as { days: string[] }).days : [];
  const keys = Object.keys(manifest.files).sort();
  console.log(`\n=== [M0] 분봉 저장본 개요 ===\n대상 ${targets.codes.length}종목(${targets.basis ?? "기준 미기록"}) | 월 파일 ${keys.length}개 | manifest 행 합계 ${Object.values(manifest.files).reduce((a, x) => a + x.rows, 0)} | manifest 용량 합계 ${mib(Object.values(manifest.files).reduce((a, x) => a + x.bytes, 0))} MiB | 마지막 완료 날짜 ${progress.cursorDate} | 수집 회차 ${progress.runs.length}회(${progress.runs.map((r) => `${r.startedAt.slice(5, 16)} 요청 ${r.requests}${r.stop ? ` 중단:${r.stop}` : ""}`).join("; ")})`);
  // ---- 읽기 ----
  const data = new Map<string, Map<number, Row[]>>();
  let next = 0;
  const work = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= keys.length) return;
      const k = keys[i], code = k.split("/")[0];
      const b = await cachedBytes(`${FWD_MIN_PREFIX}/${k}.parquet`, () => download(`${FWD_MIN_PREFIX}/${k}.parquet`));
      if (!b) throw new Error(`월 파일 없음 ${k}`);
      const byDay = data.get(code) ?? new Map<number, Row[]>();
      for (const r of (await parquetReadObjects({ file: b })) as Record<string, unknown>[]) {
        const d = Number(r.trade_date), a = byDay.get(d) ?? [];
        a.push({ hhmm: Number(r.hhmm), o: Number(r.open), h: Number(r.high), l: Number(r.low), c: Number(r.close), v: Number(r.volume), a: Number(r.amount) });
        byDay.set(d, a);
      }
      data.set(code, byDay);
    }
  };
  await Promise.all(Array.from({ length: 8 }, () => work()));
  for (const byDay of data.values()) for (const rows of byDay.values()) rows.sort((x, y) => x.hhmm - y.hhmm);
  const codes = [...data.keys()].sort();
  const allDays = [...new Set(codes.flatMap((c) => [...(data.get(c) as Map<number, Row[]>).keys()]))].sort((a, b) => a - b);
  console.log(`읽기: 종목 ${codes.length}개, 거래일 ${allDays.length}일(${iso(allDays[0])}~${iso(allDays[allDays.length - 1])}), 이번 실행 Storage 다운로드 ${mib(io.readBytes - readB0)} MiB(캐시 적중이면 0)`);

  // ---- [M1] 행 간 시각 차이, 하루 행 수 ----
  const diffH = new Map<string, number>(), rowsPerDay: number[] = [], rowsHist = new Map<string, number>();
  let rowsTotal = 0, gapRuns = 0;
  const gapStockDays: string[] = [];
  for (const c of codes) for (const [d, rows] of data.get(c) as Map<number, Row[]>) {
    rowsPerDay.push(rows.length); rowsTotal += rows.length;
    const b = rows.length <= 300 ? "≤300" : rows.length <= 360 ? "301~360" : rows.length <= 389 ? "361~389" : rows.length === 390 ? "390" : ">390";
    rowsHist.set(b, (rowsHist.get(b) ?? 0) + 1);
    let had = false;
    for (let i = 1; i < rows.length; i++) { const df = mm(rows[i].hhmm) - mm(rows[i - 1].hhmm), k = df === 1 ? "1" : df === 2 ? "2" : df <= 5 ? "3~5" : df <= 10 ? "6~10" : ">10"; diffH.set(k, (diffH.get(k) ?? 0) + 1); if (df >= 2) { gapRuns++; had = true; } }
    if (had) gapStockDays.push(`${c}|${iso(d)}`);
  }
  const totDiff = [...diffH.values()].reduce((a, x) => a + x, 0);
  console.log(`\n=== [M1] 행 간 시각 차이(같은 날 연속 행, 분)와 하루 행 수 ===\n전체 행 ${rowsTotal}, 종목-날짜 ${rowsPerDay.length}개`);
  console.log(`행 간 시각 차이 분포(분): ${["1", "2", "3~5", "6~10", ">10"].map((k) => `${k}분 ${diffH.get(k) ?? 0}(${f2(((diffH.get(k) ?? 0) / Math.max(totDiff, 1)) * 100)}%)`).join(" | ")} → 1분 간격 비율 ${f2(((diffH.get("1") ?? 0) / Math.max(totDiff, 1)) * 100)}%, 공백(≥2분) 발생 종목-날짜 ${gapStockDays.length}개(공백 횟수 ${gapRuns})`);
  console.log(`하루 행 수 분포(최대 390 대비): 최소 ${Math.min(...rowsPerDay)} / 5% ${pct(rowsPerDay, 0.05)} / 25% ${pct(rowsPerDay, 0.25)} / 중앙값 ${pct(rowsPerDay, 0.5)} / 75% ${pct(rowsPerDay, 0.75)} / 최대 ${Math.max(...rowsPerDay)} | 구간별 종목-날짜 수: ${["≤300", "301~360", "361~389", "390", ">390"].map((k) => `${k} ${rowsHist.get(k) ?? 0}`).join(", ")}`);

  // ---- [M2] 시각 커버리지: 시간외·동시호가 구간 행 유무, 첫·마지막 행 ----
  const hhmmCnt = new Map<number, number>(), firstH = new Map<string, number>(), lastH = new Map<string, number>();
  for (const c of codes) for (const rows of (data.get(c) as Map<number, Row[]>).values()) {
    for (const r of rows) hhmmCnt.set(r.hhmm, (hhmmCnt.get(r.hhmm) ?? 0) + 1);
    firstH.set(String(rows[0].hhmm).padStart(4, "0"), (firstH.get(String(rows[0].hhmm).padStart(4, "0")) ?? 0) + 1);
    lastH.set(String(rows[rows.length - 1].hhmm).padStart(4, "0"), (lastH.get(String(rows[rows.length - 1].hhmm).padStart(4, "0")) ?? 0) + 1);
  }
  const cnt = (f: (x: number) => boolean): number => [...hhmmCnt.entries()].filter(([k]) => f(k)).reduce((a, [, v]) => a + v, 0);
  console.log(`\n=== [M2] 시각(hhmm) 커버리지·시간외·동시호가 ===`);
  console.log(`전체 hhmm 범위 ${Math.min(...hhmmCnt.keys())}~${Math.max(...hhmmCnt.keys())} | 0900 이전 행 ${cnt((k) => k < 900)} | 0900 행 ${cnt((k) => k === 900)} | 0901 행 ${cnt((k) => k === 901)} | 1519 행 ${cnt((k) => k === 1519)} | 1520~1529 행 ${cnt((k) => k >= 1520 && k <= 1529)} | 1530 행 ${cnt((k) => k === 1530)} | 1531 이후(시간외) 행 ${cnt((k) => k > 1530)}`);
  console.log(`하루 첫 행 hhmm 분포: ${histo(firstH, 6)} | 마지막 행 hhmm 분포: ${histo(lastH, 6)}`);
  const perMin = (k: number): string => `${String(k).padStart(4, "0")}:${hhmmCnt.get(k) ?? 0}`;
  console.log(`분별 행 수(종목-날짜 ${rowsPerDay.length}개 중): ${[858, 859, 900, 901, 902, 1518, 1519, 1520, 1521, 1525, 1529, 1530, 1531].map(perMin).join(" ")}`);
  // 15:20~15:30 구간(종가 단일가) 행의 성격: 거래량·가격 변화
  {
    let nA = 0, vA = 0, flatA = 0, n30 = 0, v30 = 0, vPre = 0, nPre = 0;
    for (const c of codes) for (const rows of (data.get(c) as Map<number, Row[]>).values()) for (const r of rows) {
      if (r.hhmm >= 1520 && r.hhmm <= 1529) { nA++; vA += r.v; if (r.o === r.h && r.h === r.l && r.l === r.c) flatA++; }
      else if (r.hhmm === 1530) { n30++; v30 += r.v; } else if (r.hhmm >= 1510 && r.hhmm <= 1519) { nPre++; vPre += r.v; }
    }
    console.log(`15:20~15:29 행 ${nA}개: 평균 거래량 ${f2(vA / Math.max(nA, 1))}, 시고저종 동일(무체결형) 비율 ${f2((flatA / Math.max(nA, 1)) * 100)}% | 15:30 행 ${n30}개: 평균 거래량 ${f2(v30 / Math.max(n30, 1))} | 15:10~15:19 행 평균 거래량 ${f2(vPre / Math.max(nPre, 1))}`);
    let n0 = 0, v0 = 0, n1 = 0, v1 = 0;
    for (const c of codes) for (const rows of (data.get(c) as Map<number, Row[]>).values()) for (const r of rows) { if (r.hhmm === 900) { n0++; v0 += r.v; } else if (r.hhmm >= 901 && r.hhmm <= 910) { n1++; v1 += r.v; } }
    console.log(`09:00 행 ${n0}개: 평균 거래량 ${f2(v0 / Math.max(n0, 1))} | 09:01~09:10 행 ${n1}개 평균 거래량 ${f2(v1 / Math.max(n1, 1))} (시가 동시호가가 09:00 행에 들어 있는지 가늠)`);
  }

  // ---- [M3] 종목별 행 수·거래량 0 ----
  console.log(`\n=== [M3] 종목별 행 수 분포·거래량 0 분봉 비율 ===\n| 종목 | 거래일 | 행 수 | 일평균 행 | 최소~최대 일 행 | 거래량 0 행 % | 시고저종 동일 행 % |\n|---|---|---|---|---|---|---|`);
  const perStock: { c: string; rows: number; days: number }[] = [];
  let zAll = 0, flatAll = 0, nAll = 0;
  const zByHour = new Map<number, { n: number; z: number }>();
  for (const c of codes) {
    const m = data.get(c) as Map<number, Row[]>;
    let rows = 0, z = 0, fl = 0, mn = 9999, mx = 0;
    for (const rs of m.values()) { rows += rs.length; mn = Math.min(mn, rs.length); mx = Math.max(mx, rs.length); for (const r of rs) { if (r.v === 0) z++; if (r.o === r.h && r.h === r.l && r.l === r.c) fl++; const hr = Math.floor(r.hhmm / 100), e = zByHour.get(hr) ?? { n: 0, z: 0 }; e.n++; if (r.v === 0) e.z++; zByHour.set(hr, e); } }
    perStock.push({ c, rows, days: m.size }); zAll += z; flatAll += fl; nAll += rows;
    console.log(`| ${label(c)} | ${m.size} | ${rows} | ${f2(rows / m.size)} | ${mn}~${mx} | ${f2((z / rows) * 100)} | ${f2((fl / rows) * 100)} |`);
  }
  console.log(`전체: 행 ${nAll}, 거래량 0 행 ${zAll}(${f2((zAll / nAll) * 100)}%), 시고저종 동일 행 ${flatAll}(${f2((flatAll / nAll) * 100)}%) | 종목별 행 수 최소 ${Math.min(...perStock.map((x) => x.rows))} 중앙값 ${median(perStock.map((x) => x.rows))} 최대 ${Math.max(...perStock.map((x) => x.rows))}`);
  console.log(`시(hour)별 거래량 0 행 비율: ${[...zByHour.entries()].sort((a, b) => a[0] - b[0]).map(([hr, e]) => `${hr}시 ${f2((e.z / e.n) * 100)}%`).join(" | ")}`);

  // ---- [M4] 누락 종목-날짜 ----
  console.log(`\n=== [M4] 누락 종목-날짜(응답 행 없음)·짧은 날 ===`);
  const missing: string[] = [];
  const dayList = (calDays.length ? calDays.map((d) => Number(d.replace(/-/g, ""))) : allDays).filter((d) => d >= allDays[0] && d <= allDays[allDays.length - 1]);
  for (const c of codes) for (const d of dayList) if (!(data.get(c) as Map<number, Row[]>).has(d)) missing.push(`${c}|${iso(d)}`);
  const emptyFromProgress = Object.entries(progress.stocks).flatMap(([c, s]) => s.emptyDays.map((d) => `${c}|${d}`)), shortFromProgress = Object.entries(progress.stocks).flatMap(([c, s]) => s.shortDays.map((d) => `${c}|${d}`));
  console.log(`거래일 목록 ${dayList.length}일 × ${codes.length}종목 중 분봉 행이 없는 종목-날짜 ${missing.length}건: ${missing.map((k) => { const [c, d] = k.split("|"); const s = h.byCode.get(c), i = s?.idx.get(d); return `${label(c)} ${d}${s ? (i !== undefined ? "(같은 날 일봉 행 있음)" : d <= h.dataEnd ? "(같은 날 일봉 행 없음=거래정지 후보)" : "(일봉 범위 밖)") : ""}`; }).join("; ") || "없음"}`);
  console.log(`수집 진행 기록: 비어 있던 날 ${emptyFromProgress.length}건 ${emptyFromProgress.join(", ") || "-"} | 짧은 날(300행 미만) ${shortFromProgress.length}건 ${shortFromProgress.join(", ") || "-"}`);
  console.log(`누락 날짜가 몰린 날짜별 건수: ${histo(missing.reduce((m, k) => m.set(k.split("|")[1], (m.get(k.split("|")[1]) ?? 0) + 1), new Map<string, number>()), 8)} | 종목별: ${histo(missing.reduce((m, k) => m.set(label(k.split("|")[0]), (m.get(label(k.split("|")[0])) ?? 0) + 1), new Map<string, number>()), 8)}`);
  console.log(`행 사이 공백(≥2분) 종목-날짜 ${gapStockDays.length}개(VI·거래정지 표기 컬럼은 저장본에 없다. 공백은 그 가능성의 간접 지표일 뿐): ${gapStockDays.slice(0, 12).join(", ")}${gapStockDays.length > 12 ? " …" : ""}`);

  // ---- [M5] 마지막 행·마지막 날 잠정 여부 ----
  console.log(`\n=== [M5] 마지막 행·마지막 날(잠정 여부) ===`);
  {
    const lastDay = allDays[allDays.length - 1], prev = allDays[allDays.length - 2];
    const stat = (d: number): string => { const a: number[] = [], l = new Map<string, number>(); for (const c of codes) { const rs = (data.get(c) as Map<number, Row[]>).get(d); if (rs) { a.push(rs.length); l.set(String(rs[rs.length - 1].hhmm), (l.get(String(rs[rs.length - 1].hhmm)) ?? 0) + 1); } } return `${iso(d)}: 종목 ${a.length}, 일 행 수 중앙값 ${median(a)} 최소 ${Math.min(...a)} 최대 ${Math.max(...a)}, 마지막 행 hhmm ${histo(l, 4)}`; };
    console.log(`${stat(lastDay)} | ${stat(prev)}`);
    console.log(`수집 규칙: 당일 분봉은 장 마감 후(15:40 KST 이후)에 받는다(forward-data-plan.md 2.5). 마지막 완료 날짜 ${progress.cursorDate}, 마지막 회차 시작 ${progress.runs[progress.runs.length - 1]?.startedAt}. 마지막 날 마지막 행이 다른 날과 같은 hhmm·행 수 분포이면 잠정(부분 봉) 징후 없음으로 본다.`);
  }

  // ---- [M6] 누적대금(amount) 성격·일봉 거래대금 대조, 가격 단위 ----
  console.log(`\n=== [M6] 누적대금 성격·가격 단위(호가) ===`);
  {
    let dec = 0, inc = 0, n = 0;
    const ratios: number[] = [], tickBad = new Map<string, number>(), tickAll = new Map<string, number>();
    const daily = await loadAllStockSeriesFromParquet(2025, 2026);
    for (const c of codes) {
      const dm = new Map((daily.get(c) ?? []).map((r) => [r.tradeDate, r]));
      for (const [d, rows] of data.get(c) as Map<number, Row[]>) {
        for (let i = 1; i < rows.length; i++) { n++; if (rows[i].a < rows[i - 1].a) dec++; else if (rows[i].a > rows[i - 1].a) inc++; }
        const dr = dm.get(iso(d));
        if (dr && dr.tradingValue > 0 && rows.length) ratios.push(rows[rows.length - 1].a / dr.tradingValue);
        // 호가 단위: 그날 시가·고가·저가·종가 값들의 최대공약수 vs 가격대별 호가
        let g = 0;
        for (const r of rows) for (const p of [r.o, r.h, r.l, r.c]) if (p > 0) g = gcd(g, p);
        const mid = rows[Math.floor(rows.length / 2)]?.c ?? 0;
        if (mid > 0) { const t = tickOf(mid), key = `${t}원`; tickAll.set(key, (tickAll.get(key) ?? 0) + 1); if (g % t !== 0 && t % g !== 0 && g < t) tickBad.set(key, (tickBad.get(key) ?? 0) + 1); }
      }
    }
    console.log(`누적대금 행 간 변화: 증가 ${inc} / 감소 ${dec} / 전체 ${n}(감소 ${f2((dec / Math.max(n, 1)) * 100)}% → ${dec === 0 ? "단조 누적(분 거래대금은 차분)" : "단조 아님"}) | 마지막 행 누적대금 ÷ 일봉 거래대금(tradingValue, 2025~2026 고정 스냅샷 겹침 ${ratios.length}건): 중앙값 ${f2(median(ratios))} 5% ${f2(pct(ratios, 0.05))} 95% ${f2(pct(ratios, 0.95))}`);
    console.log(`호가 단위 점검(그날 시고저종 값들의 최대공약수 g가 가격대별 호가 t의 약수가 아닌 경우 = 의심): 가격대별 종목-날짜 ${[...tickAll.entries()].map(([k, v]) => `${k} ${v}`).join(", ")} | 의심 ${[...tickBad.entries()].map(([k, v]) => `${k} ${v}`).join(", ") || "0건"}`);
    // ---- [M7] 분봉 종가 vs 일봉 종가 표본 20건 ----
    const rng = mulberry32(20261123), pool: { c: string; d: number }[] = [];
    for (const c of codes) for (const d of (data.get(c) as Map<number, Row[]>).keys()) if (iso(d) <= h.dataEnd && dm0(daily, c, d)) pool.push({ c, d });
    pool.sort((a, b) => (a.c < b.c ? -1 : a.c > b.c ? 1 : a.d - b.d));
    const pick: { c: string; d: number }[] = [];
    while (pick.length < 20 && pool.length) pick.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
    console.log(`\n=== [M7] 분봉 종가 vs 같은 날 일봉 종가 표본 ${pick.length}건(시드 20261123, 일봉은 고정 스냅샷 ${h.dataEnd}까지) ===\n| 종목 | 날짜 | 분봉 마지막 행(hhmm) 종가 | 분봉 15:20 직전 행 종가 | 일봉 종가 | 마지막 행 일치 | 차이 원 |\n|---|---|---|---|---|---|---|`);
    let ok = 0;
    for (const { c, d } of pick) {
      const rows = (data.get(c) as Map<number, Row[]>).get(d) as Row[], last = rows[rows.length - 1], pre = [...rows].reverse().find((r) => r.hhmm < 1520), dr = dm0(daily, c, d) as { closePrice: number };
      const same = last.c === dr.closePrice; if (same) ok++;
      console.log(`| ${label(c)} | ${iso(d)} | ${last.c}(${String(last.hhmm).padStart(4, "0")}) | ${pre ? pre.c : "-"} | ${dr.closePrice} | ${same ? "O" : "X"} | ${last.c - dr.closePrice} |`);
    }
    console.log(`표본 ${pick.length}건 중 분봉 마지막 행 종가 = 일봉 종가 ${ok}건`);
  }

  // ---- [M8] 069500 일수익·코스피 흐름(참고용) ----
  console.log(`\n=== [M8] 분봉 기간 069500 일수익·코스피 흐름(참고용, 가격 수익만) ===`);
  {
    const a = iso(allDays[0]), z = iso(allDays[allDays.length - 1]);
    const ret = new Map<string, number>();
    bh.dates.forEach((d, i) => ret.set(d, bh.ret[i]));
    const csv = await import("node:fs").then((fs) => fs.promises.readFile("docs/research/ds6-forward-log.csv", "utf8")).catch(() => "");
    for (const line of csv.split("\n").slice(1)) { const p = line.split(","); if (p[0] && p[2] !== undefined && !ret.has(p[0])) ret.set(p[0], Number(p[2])); }
    const ds = [...ret.keys()].filter((d) => d >= a && d <= z).sort();
    const rs = ds.map((d) => ret.get(d) as number);
    const cum = rs.reduce((v, r) => v * (1 + r / 100), 1) - 1, mean = avg(rs), sd = Math.sqrt(avg(rs.map((r) => (r - mean) ** 2)));
    const byM = new Map<string, number>();
    ds.forEach((d, i) => byM.set(d.slice(0, 7), (byM.get(d.slice(0, 7)) ?? 1) * (1 + rs[i] / 100)));
    console.log(`069500(원주가, 보조 파일 ${h.dataEnd}까지 + 연구 DS6 포워드 로그 이후) ${a}~${z} ${ds.length}거래일(분봉 거래일 ${allDays.length}일): 누적 ${f2(cum * 100)}%, 일평균 ${f2(mean)}%, 일 표준편차 ${f2(sd)}%, 상승일 ${rs.filter((x) => x > 0).length}/하락일 ${rs.filter((x) => x < 0).length}, 최대 일상승 ${f2(Math.max(...rs))}%/일하락 ${f2(Math.min(...rs))}%`);
    console.log(`월별 069500 %: ${[...byM.entries()].map(([k, v]) => `${k} ${f2((v - 1) * 100)}`).join(" | ")}`);
    const kospi = await getIndexPriceSeries("KOSPI", "2025-11-01", z), kosdaq = await getIndexPriceSeries("KOSDAQ", "2025-11-01", z);
    const lv = (ser: { tradeDate: string; closePrice: number }[], d: string): number => { const x = [...ser].reverse().find((p) => p.tradeDate <= d); return x ? x.closePrice : Number.NaN; };
    const mEnds = [...new Set(ds.map((d) => d.slice(0, 7)))].map((m) => ds.filter((d) => d.startsWith(m)).pop() as string);
    console.log(`코스피 지수 ${a}→${z}: ${f2(lv(kospi, a))} → ${f2(lv(kospi, z))} (${f2((lv(kospi, z) / lv(kospi, a) - 1) * 100)}%) | 코스닥 ${f2(lv(kosdaq, a))} → ${f2(lv(kosdaq, z))} (${f2((lv(kosdaq, z) / lv(kosdaq, a) - 1) * 100)}%) | 월말 코스피: ${mEnds.map((d) => `${d.slice(0, 7)} ${f2(lv(kospi, d))}`).join(", ")}`);
  }
  console.log(`\n분봉 점검 1단계 종료(집계만, 수익·신호 계산 없음) | 연구 자료 파일 캐시 적중·다운로드는 아래 읽기량 줄 참고`);
}
const dm0 = (daily: Map<string, { tradeDate: string; closePrice: number }[]>, c: string, d: number): { closePrice: number } | undefined => (daily.get(c) ?? []).find((r) => r.tradeDate === iso(d));
