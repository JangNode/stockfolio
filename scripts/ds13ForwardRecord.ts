/**
 * [임시 연구 — 병합 금지, 읽기 전용] DS13L·DS13M 포워드 기록(연구 DS6 포워드 도구 research-ds6-forward.ts 가 호출한다). 정의 동결: docs/research/ds13-forward-freeze.md.
 * 계산 코드는 lib/ds13Engine.ts(research-batch5.ts 에서 옮긴 그대로). 가격 데이터만 쓰고 DB·Storage 쓰기 0, 외부 요청 0(069500 종가는 호출 쪽이 넘긴다), 공시(DART) 사용 없음.
 * 검증 단계: 고정 스냅샷에서 DS13L·DS13M·DS6 기록값(보정 적용 데이터)을 재현하지 못하면 중단한다.
 * 관찰 단계: 동결 다음 거래일부터 일별 수익(DS13L·DS13M·DS6·069500, 하위 계좌별 열), 월 신호·체결 기록(추가만), 현재 보유 종목표, 제한폭 초과·조정 이벤트 없음 경고(자동 보정 없음)를 쓴다.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { SimTrade } from "@/lib/slotSim";
import { makeDs13Engine, type K200PInfo } from "@/lib/ds13Engine";
import { DS13F_FREEZE_COMMIT, DS13F_START_AFTER, DS13F_REC_FULL, DS13F_REC_W1, DS13F_W1_END, DS13F_VERIFY_FILE, DS13F_LOG_CSV, DS13F_SIGNALS_CSV, DS13F_DQ_CSV, DS13F_HOLDINGS_MD, DS13F_CSV_HEADER, DS13F_SIGNALS_HEADER, DS13F_DQ_HEADER, DS13F_DQ_AFTER } from "@/lib/ds13ForwardConfig";
import { DQ_LIMIT_CHANGE_DATE, DQ_LIMIT_BEFORE, DQ_LIMIT_AFTER, DQ_LIMIT_TOL } from "@/lib/dataQualityConfig";
import { f2, type Harness, type Win } from "./researchHarness";
import type { Windows } from "./researchGates";

export interface Ds13Args { h: Harness; k200p: K200PInfo; fixedDate: string; forward: boolean; /** 날짜 → 069500 원주가 종가·출처(관찰 단계) */ closes: Map<string, { px: number; src: string }>; /** 이 도구의 DS6(기존 계산) 일수익(%): 정보 대조용 */ ds6ToolRet: Map<string, number>; /** 시작 기준일(기본 DS13F_START_AFTER). 테스트 모드에서만 바꾼다. */ startAfter?: string; /** 테스트 모드: 이 폴더에 쓴다(docs/research 에 쓰지 않음). */ outDir?: string }
type Rec = { cagr: string; mdd: string };

const readLines = async (file: string): Promise<string[]> => { try { return (await fs.readFile(file, "utf8")).split(/\r?\n/).filter((l) => l.trim() !== ""); } catch { return []; } };
const csvName = (s: string): string => s.replace(/,/g, " ");

export async function ds13Phase(a: Ds13Args): Promise<void> {
  const { h, k200p, fixedDate, forward } = a;
  const START = a.startAfter ?? DS13F_START_AFTER;
  const P = (f: string): string => (a.outDir ? path.join(a.outDir, path.basename(f)) : f);
  if (a.outDir) await fs.mkdir(a.outDir, { recursive: true });
  const { CAL, nCal } = h;
  const nameOf = (c: string): string => csvName(k200p.nameOf.get(c) ?? "?");
  const T = Date.now();
  const E = makeDs13Engine(h, k200p);
  const cS13 = E.startOf(E.RM1, false);
  if (E.startOf(E.MV1, false) !== cS13) throw new Error("DS13: RM1과 MV1의 첫 신호일이 다르다");
  const from = CAL[cS13 + 1];
  const W13: Windows = { NW: [], FULL: { from, to: "9999-12-31" }, ALL: [] };
  console.log(`\n=== DS13 포워드 기록(${forward ? "관찰" : "검증"} 단계) | 동결 커밋 ${DS13F_FREEZE_COMMIT} | 첫 신호일 ${CAL[cS13]}, 수익 집계 ${from}~${h.dataEnd} | 시작 기준일 ${START}(다음 거래일부터 기록) ===`);
  const dL = E.d13Of("LV1", cS13, W13), dM = E.d13Of("MV1", cS13, W13);
  const ds6 = E.build(E.DS6D).res.run;
  const runs: [string, { dates: string[]; ret: number[] }][] = [["DS13L", dL.base.res.run], ["DS13M", dM.base.res.run], ["DS6", ds6]];

  // ---- 검증: 기록값 재현(보정 적용 데이터, 고정 스냅샷) ----
  const wFull: Win = { from, to: fixedDate }, wW1: Win = { from, to: DS13F_W1_END };
  const rows: string[] = [];
  let ok = true;
  for (const [id, run] of runs) {
    const sF = h.st(run, wFull), sA = h.st(run, wW1), rF = DS13F_REC_FULL[id as keyof typeof DS13F_REC_FULL] as Rec, rA = DS13F_REC_W1[id as keyof typeof DS13F_REC_W1] as Rec;
    const okF = f2(sF.cagr) === rF.cagr && f2(sF.mdd) === rF.mdd, okA = f2(sA.cagr) === rA.cagr && f2(sA.mdd) === rA.mdd;
    if (!okF || !okA) ok = false;
    rows.push(`| ${id} | ${from}~${DS13F_W1_END} | ${f2(sA.cagr)} / ${f2(sA.mdd)} | ${rA.cagr} / ${rA.mdd} | ${okA ? "일치" : "불일치"} |`, `| ${id} | ${from}~${fixedDate} | ${f2(sF.cagr)} / ${f2(sF.mdd)} | ${rF.cagr} / ${rF.mdd} | ${okF ? "일치" : "불일치"} |`);
  }
  console.log(`\n=== DS13 검증: 고정 구간 재계산 vs 기록값 (CAGR % / MDD %, 보정 적용 데이터) ===\n| 전략 | 구간 | 이번 계산 | 기록값 | 판정 |\n|---|---|---|---|---|\n${rows.join("\n")}`);
  if (!ok) throw new Error("DS13 고정 구간 재계산이 기록값과 다르다 — 관찰 단계로 넘어가지 않고 멈춘다. 보고한다");

  const preOf = (r: { dates: string[]; ret: number[] }): { d: string[]; r: number[] } => { const d: string[] = [], v: number[] = []; r.dates.forEach((x, i) => { if (x >= from && x <= fixedDate) { d.push(x); v.push(r.ret[i]); } }); return { d, r: v }; };
  if (!forward) {
    await fs.mkdir(path.dirname(DS13F_VERIFY_FILE), { recursive: true });
    await fs.writeFile(DS13F_VERIFY_FILE, JSON.stringify({ fixedDate, from, runs: Object.fromEntries(runs.map(([id, r]) => [id, preOf(r)])) }));
    console.log(`\nDS13 검증 단계 통과: DS13L·DS13M·DS6 고정 구간 재계산이 기록값과 일치, 고정 구간 일별 ${preOf(dL.base.res.run).d.length}일 저장 | 소요 ${((Date.now() - T) / 1000).toFixed(0)}초`);
    return;
  }

  // ---- 관찰 단계: 라이브 데이터 계산의 고정 구간이 검증 단계 일별 수익과 같은지 정보로 대조 ----
  const ref = JSON.parse(await fs.readFile(DS13F_VERIFY_FILE, "utf8")) as { fixedDate: string; from: string; runs: Record<string, { d: string[]; r: number[] }> };
  const info: string[] = [];
  for (const [id, run] of runs) {
    const cur = preOf(run), rf = ref.runs[id];
    let nDiff = 0, maxD = 0;
    const shapeOk = !!rf && rf.d.length === cur.d.length && cur.d.every((d, i) => d === rf.d[i]);
    if (shapeOk) cur.r.forEach((v, i) => { const df = Math.abs(v - rf.r[i]); if (df > 1e-6) nDiff++; maxD = Math.max(maxD, df); });
    info.push(`${id} 날짜 ${shapeOk ? "일치" : "불일치"}, 1e-6%p 넘게 다른 날 ${nDiff}일, 최대 ${maxD.toExponential(2)}%p`);
  }
  console.log(`라이브 데이터 계산의 고정 구간 일별 수익 vs 검증 단계(고정 스냅샷, 정보용): ${info.join(" | ")}`);
  { // DS6: 이 도구의 기존 DS6 계산과 엔진 DS6 비교(정보용)
    let mx = 0, n = 0;
    ds6.dates.forEach((d, i) => { const t = a.ds6ToolRet.get(d); if (t !== undefined) { n++; mx = Math.max(mx, Math.abs(t - ds6.ret[i])); } });
    console.log(`DS6 일수익: 기존 DS6 포워드 계산 vs 엔진 계산 ${n}일 비교, 최대 차이 ${mx.toExponential(2)}%p (정보용)`);
  }

  const bMap = new Map(h.bhP.dates.map((d, i) => [d, h.bhP.ret[i]]));
  const idx = (r: { dates: string[] }): Map<string, number> => new Map(r.dates.map((d, i) => [d, i]));
  const iL = idx(dL.base.res.run), iM = idx(dM.base.res.run), i6 = idx(ds6);
  const dates = dL.base.res.run.dates;
  const obs: string[] = [];
  for (const d of dates) { if (d <= START) continue; if (!bMap.has(d)) break; obs.push(d); }
  const lastTwo = CAL.slice(-2), nAt = (d: string): number => h.stocks.filter((s) => s.idx.has(d)).length, cnt = lastTwo.map(nAt);
  console.log(`가격 데이터 마지막 거래일 ${h.dataEnd} | 최근 두 거래일 종목 수 ${lastTwo.map((d, k) => `${d} ${cnt[k]}`).join(", ")}${cnt[1] < cnt[0] * 0.9 ? " — 경고: 마지막 날 종목 수가 크게 적다(부분 데이터 가능)" : ""}`);

  const prev = new Map<string, string[]>();
  { const ls = await readLines(P(DS13F_LOG_CSV)); if (ls.length) { if (ls[0] !== DS13F_CSV_HEADER) throw new Error(`${DS13F_LOG_CSV} 헤더가 기대와 다르다 — 덮어쓰지 않고 중단한다`); for (const l of ls.slice(1)) { const c = l.split(","); prev.set(c[0], c); } } }
  const cum = { L: 1, M: 1, S: 1, B: 1 }, pk = { L: 1, M: 1, S: 1, B: 1 }, mdd = { L: 0, M: 0, S: 0, B: 0 };
  const out: string[][] = [];
  for (const d of obs) {
    const rL = dL.base.res.run.ret[iL.get(d) as number], rM = dM.base.res.run.ret[iM.get(d) as number], r6 = ds6.ret[i6.get(d) as number], rb = bMap.get(d) as number;
    const cl = a.closes.get(d);
    if (!cl) throw new Error(`${d} 069500 원주가 종가 기록이 없다`);
    const rs: [keyof typeof cum, number][] = [["L", rL], ["M", rM], ["S", r6], ["B", rb]];
    const cumS: string[] = [], ddS: string[] = [];
    for (const [k, r] of rs) { cum[k] *= 1 + r / 100; pk[k] = Math.max(pk[k], cum[k]); const dd = (cum[k] / pk[k] - 1) * 100; mdd[k] = Math.min(mdd[k], dd); cumS.push(((cum[k] - 1) * 100).toFixed(4)); ddS.push(dd.toFixed(4)); }
    const sl = (dd: typeof dL, which: "L" | "M"): string[] => { const ix = (which === "L" ? iL : iM).get(d) as number; return [...dd.base.sls.map((s) => s.ret[ix].toFixed(4)), ...dd.base.res.wEnd[ix].map((w) => w.toFixed(5))]; };
    out.push([d, rL.toFixed(4), rM.toFixed(4), r6.toFixed(4), rb.toFixed(4), ...cumS, ...ddS, ...sl(dL, "L"), ...sl(dM, "M"), String(cl.px), cl.src]);
  }
  let nChanged = 0;
  for (const r of out) { const p = prev.get(r[0]); if (p && p.slice(1, 5).join() !== r.slice(1, 5).join()) nChanged++; }
  await fs.mkdir(path.dirname(DS13F_LOG_CSV), { recursive: true });
  await fs.writeFile(P(DS13F_LOG_CSV), [DS13F_CSV_HEADER, ...out.map((r) => r.join(","))].join("\n") + "\n");
  console.log(`\n=== DS13 포워드 관찰(${START} 종가 = 100, 다음 거래일부터) 마지막 10일 ===\n| 날짜 | DS13L 일 % | DS13M 일 % | DS6 일 % | 069500 일 % | DS13L 누적 | DS13M 누적 | DS6 누적 | 069500 누적 | DS13L 하위 계좌 일 %(코어/모멘텀/저위험) |\n|---|---|---|---|---|---|---|---|---|---|`);
  for (const r of out.slice(-10)) console.log(`| ${r[0]} | ${r[1]} | ${r[2]} | ${r[3]} | ${r[4]} | ${r[5]} | ${r[6]} | ${r[7]} | ${r[8]} | ${r[13]} / ${r[14]} / ${r[15]} |`);
  const last = out[out.length - 1];
  const summary = last
    ? `DS13 포워드 ${out[0][0]}~${last[0]}(${out.length}거래일): 누적 % DS13L ${last[5]} / DS13M ${last[6]} / DS6 ${last[7]} / 069500 ${last[8]} | 최저 낙폭 % DS13L ${mdd.L.toFixed(2)} / DS13M ${mdd.M.toFixed(2)} / DS6 ${mdd.S.toFixed(2)} / 069500 ${mdd.B.toFixed(2)} | 6개월 미만이면 판정 없음(ds13-forward-freeze.md §3)`
    : `DS13 포워드: 기록 구간 0거래일(${START} 이후 4개 계열 모두 있는 거래일 없음)`;

  // ---- 월 신호·체결 기록(추가만): 실제 시뮬레이션이 쓴 목표표를 그대로 기록 ----
  const startC = CAL.findIndex((d) => d > START);
  const rmTg = new Map<number, Map<string, number>>(), mvTg = new Map<number, Map<string, number>>();
  const recRun = (def: typeof E.RM1, sink: Map<number, Map<string, number>>): { dates: string[]; ret: number[]; open: SimTrade[] } => {
    const wrapped = { ...def, targets: (c: number, held: ReadonlySet<string>, P0: unknown, mult: number, swap: boolean) => { const t = (def as unknown as { targets: (c: number, h: ReadonlySet<string>, P: unknown, m: number, s: boolean) => Map<string, number> }).targets(c, held, P0, mult, swap); sink.set(c, new Map(t)); return t; } };
    return E.runS(wrapped as never, def.P0 as never, cS13, null, { lag: 1, detail: true }) as never;
  };
  const rmRun = recRun(E.RM1, rmTg);
  const mvRun = recRun(E.MV1 as never, mvTg);
  const sameRun = (x: { dates: string[]; ret: number[] }, y: { dates: string[]; ret: number[] }): boolean => x.dates.length === y.dates.length && x.ret.every((v, i) => v === y.ret[i]);
  if (!sameRun(rmRun, dL.base.rm) || !sameRun(mvRun, dM.base.low)) throw new Error("DS13 기록용 재실행이 기준 계산과 다르다 — 중단");
  const coreEv = E.simCore(2, { lag: 1 }).events;
  const sigRows = new Map<string, string[]>(); // 그룹 키 → 행들
  const put = (key: string, row: string): void => { const g = sigRows.get(key) ?? []; g.push(row); sigRows.set(key, g); };
  for (const [c, t] of rmTg) if (c >= startC - 1 && CAL[c] > START && c + 1 < nCal) for (const [code, w] of [...t].sort((x, y) => y[1] - x[1])) put(`${CAL[c]}|${CAL[c + 1]}|mom`, `${CAL[c]},${CAL[c + 1]},mom,${code},${nameOf(code)},${(w * 100).toFixed(3)},RM1 목표`);
  for (const [c, t] of mvTg) if (CAL[c] > START && c + 1 < nCal) for (const [code, w] of [...t].sort((x, y) => y[1] - x[1])) put(`${CAL[c]}|${CAL[c + 1]}|low_M`, `${CAL[c]},${CAL[c + 1]},low_M,${code},${nameOf(code)},${(w * 100).toFixed(3)},MV1 목표(하위 계좌 안 비중)`);
  for (const e of coreEv) if (CAL[e.c] > START) e.set.forEach((code, j) => put(`${CAL[e.c - 1]}|${CAL[e.c]}|core`, `${CAL[e.c - 1]},${CAL[e.c]},core,${code},${nameOf(code)},${(e.w[j] * 100).toFixed(3)},코어 체결 후 비중${e.sells.length ? `(매도 ${e.sells.join("+")})` : ""}${e.buys.length ? `(매수 ${e.buys.join("+")})` : ""}`));
  const lvRun = E.runLV1({ lag: 1 });
  for (const t of lvRun.trades) { if (CAL[t.entryC] > START) put(`${CAL[t.entryC - 1]}|${CAL[t.entryC]}|low_L`, `${CAL[t.entryC - 1]},${CAL[t.entryC]},low_L,${t.code},${nameOf(t.code)},,LV1 진입`); if (CAL[t.exitC] > START) put(`${CAL[t.exitC - 1]}|${CAL[t.exitC]}|low_L`, `${CAL[t.exitC - 1]},${CAL[t.exitC]},low_L,${t.code},${nameOf(t.code)},,LV1 청산(${t.reason.replace(/,/g, " ")})`); }
  for (const [lbl, d] of [["L", dL], ["M", dM]] as const) d.base.res.moved.forEach((mv, i) => { const dt = d.base.res.run.dates[i]; if (mv > 1e-12 && dt > START) put(`${CAL[(h.calIdx.get(dt) as number) - 1]}|${dt}|move_${lbl}`, `${CAL[(h.calIdx.get(dt) as number) - 1]},${dt},move_${lbl},,,${(mv * 100).toFixed(4)},하위 계좌 이동 금액(전일 계좌 평가액 대비 %) 비용 ${(d.base.res.cost[i] * 100).toFixed(4)}%`); });
  const sigOld = await readLines(P(DS13F_SIGNALS_CSV));
  if (sigOld.length && sigOld[0] !== DS13F_SIGNALS_HEADER) throw new Error(`${DS13F_SIGNALS_CSV} 헤더가 기대와 다르다 — 덮어쓰지 않고 중단한다`);
  const oldGroups = new Map<string, string[]>();
  for (const l of sigOld.slice(1)) { const c = l.split(","); const k = `${c[0]}|${c[1]}|${c[2]}`; (oldGroups.get(k) ?? oldGroups.set(k, []).get(k) as string[]).push(l); }
  let sigChanged = 0, sigNew = 0;
  const finalSig: string[] = [...oldGroups.values()].flat();
  for (const [k, g] of sigRows) {
    const o = oldGroups.get(k);
    if (!o) { finalSig.push(...g); sigNew++; continue; }
    if ([...o].sort().join("\n") !== [...g].sort().join("\n")) sigChanged++; // 이미 기록된 신호는 소급 수정하지 않는다
  }
  finalSig.sort();
  await fs.writeFile(P(DS13F_SIGNALS_CSV), [DS13F_SIGNALS_HEADER, ...finalSig].join("\n") + "\n");
  console.log(`월 신호·체결 기록: 기록 그룹 ${oldGroups.size}개 + 신규 ${sigNew}개, 이미 기록된 그룹과 달라진 것 ${sigChanged}개${sigChanged ? " — 경고: 소급 수정하지 않고 기존 기록을 유지했다(데이터 개정 가능성)" : ""}`);

  // ---- 현재 보유 종목표 ----
  let coreHeld: [string, number][] = [], lvHeld: [string, number][] = [];
  E.simCore(2, { lag: 1, onDay: (c, V, held) => { if (c === nCal - 1) coreHeld = held.map(([code, v]) => [code, v / V]); } });
  E.runLV1({ lag: 1, onDay: (c, V, held) => { if (c === nCal - 1) { lvHeld = held.map(([code, v]) => [code, v / V]); } } });
  const lastC = Math.max(...[...rmTg.keys()].filter((c) => c < nCal - 1)), lastMvC = Math.max(...[...mvTg.keys()].filter((c) => c < nCal - 1));
  const fmtL = (xs: [string, number][]): string => xs.sort((x, y) => y[1] - x[1]).map(([code, w]) => `| ${code} | ${nameOf(code)} | ${(w * 100).toFixed(2)} |`).join("\n");
  const wNow = (d: typeof dL): number[] => d.base.res.wEnd[d.base.res.wEnd.length - 1];
  const md = `# DS13 포워드 현재 보유 종목표 (자동 생성, ${h.dataEnd} 종가 기준)

연구 브랜치 전용. 정의 동결 ${DS13F_FREEZE_COMMIT}(docs/research/ds13-forward-freeze.md). 이 파일은 실행할 때마다 다시 쓴다(소급 기록은 ds13-forward-signals.csv).

## 하위 계좌 비중(계좌 평가액 대비, 종가)
| 전략 | 코어 | 모멘텀 | 저위험 |
|---|---|---|---|
| DS13L | ${wNow(dL).map((w) => (w * 100).toFixed(2)).join(" | ")} |
| DS13M | ${wNow(dM).map((w) => (w * 100).toFixed(2)).join(" | ")} |

## 코어(하위 계좌 안 비중 %, 종가 기준)
| 코드 | 종목 | 비중 % |
|---|---|---|
${fmtL(coreHeld)}

## 모멘텀 위성 RM1 (최근 신호 ${CAL[lastC]}의 목표 비중, 하위 계좌 안 %, 보유 ${rmRun.open.length}종목)
| 코드 | 종목 | 목표 비중 % |
|---|---|---|
${fmtL([...(rmTg.get(lastC) ?? new Map<string, number>())].map(([c, w]) => [c, w] as [string, number]))}

## 저위험 위성 — DS13M: MV1 (최근 신호 ${CAL[lastMvC]}의 목표 비중, 하위 계좌 안 %, 보유 ${mvRun.open.length}종목)
| 코드 | 종목 | 목표 비중 % |
|---|---|---|
${fmtL([...(mvTg.get(lastMvC) ?? new Map<string, number>())].map(([c, w]) => [c, w] as [string, number]))}

## 저위험 위성 — DS13L: LV1 (하위 계좌 안 비중 %, 보유 ${lvHeld.length}종목, 종가 기준)
| 코드 | 종목 | 비중 % |
|---|---|---|
${fmtL(lvHeld)}
`;
  await fs.writeFile(P(DS13F_HOLDINGS_MD), md);

  // ---- 새로 쌓이는 가격의 제한폭 초과·조정 이벤트 없음 경고(자동 보정 없음) ----
  const evBy = new Map<string, string[]>();
  for (const [code, list] of h.adjustments) evBy.set(code, list.map((e) => e.eventDate).sort());
  const hasEv = (code: string, a0: string, b0: string): boolean => (evBy.get(code) ?? []).some((d) => d > a0 && d <= b0);
  const heldBy = (code: string): string => [coreHeld.some(([c]) => c === code) ? "core" : "", (rmTg.get(lastC)?.has(code) ?? false) ? "mom" : "", (mvTg.get(lastMvC)?.has(code) ?? false) ? "low_M" : "", lvHeld.some(([c]) => c === code) ? "low_L" : ""].filter(Boolean).join("+") || "-";
  const dqOld = await readLines(P(DS13F_DQ_CSV));
  if (dqOld.length && dqOld[0] !== DS13F_DQ_HEADER) throw new Error(`${DS13F_DQ_CSV} 헤더가 기대와 다르다 — 덮어쓰지 않고 중단한다`);
  const dqKeys = new Set(dqOld.slice(1).map((l) => l.split(",").slice(0, 2).join("|")));
  const dqNew: string[] = [], dqPrint: string[] = [];
  let scanned = 0;
  for (const s of h.stocks) {
    for (let i = 1; i < s.dates.length; i++) {
      const d = s.dates[i];
      if (d <= DS13F_DQ_AFTER) continue;
      const pi = i - 1;
      if (!(s.close[pi] > 0 && s.close[i] > 0)) continue;
      scanned++;
      const adjR = s.close[i] / s.close[pi] - 1, lim = d <= DQ_LIMIT_CHANGE_DATE ? DQ_LIMIT_BEFORE : DQ_LIMIT_AFTER;
      if (Math.abs(adjR) <= lim + DQ_LIMIT_TOL || hasEv(s.code, s.dates[pi], d)) continue;
      const rawR = s.raw[i] / s.raw[pi] - 1, gap = (h.calIdx.get(d) as number) - (h.calIdx.get(s.dates[pi]) as number);
      const row = [d, s.code, nameOf(s.code), (adjR * 100).toFixed(2), (rawR * 100).toFixed(2), String(gap), ((lim + DQ_LIMIT_TOL) * 100).toFixed(1), heldBy(s.code), h.dataEnd].join(",");
      dqPrint.push(`${d} ${s.code} ${nameOf(s.code)} 수정 ${(adjR * 100).toFixed(2)}% 원 ${(rawR * 100).toFixed(2)}% 간격 ${gap} 보유 ${heldBy(s.code)}`);
      if (!dqKeys.has(`${d}|${s.code}`)) dqNew.push(row);
    }
  }
  await fs.writeFile(P(DS13F_DQ_CSV), [DS13F_DQ_HEADER, ...dqOld.slice(1), ...dqNew].join("\n") + "\n");
  console.log(`제한폭 초과·조정 이벤트 없음 탐지(${DS13F_DQ_AFTER} 뒤 종목-일 ${scanned.toLocaleString()}개 검사, 자동 보정 없음): ${dqPrint.length}건 ${dqPrint.length ? "— 경고" : ""}${dqPrint.length ? "\n  " + dqPrint.slice(0, 20).join("\n  ") : ""}`);
  console.log(`\n${summary}\n이전 로그와 일수익이 달라진 행 ${nChanged}개 | 로그 ${DS13F_LOG_CSV} ${out.length}행 | 신호 기록 ${DS13F_SIGNALS_CSV} | 보유 ${DS13F_HOLDINGS_MD} | DQ ${DS13F_DQ_CSV}(신규 ${dqNew.length}건) | 소요 ${((Date.now() - T) / 1000).toFixed(0)}초`);
  if (a.outDir) for (const f of [DS13F_LOG_CSV, DS13F_SIGNALS_CSV, DS13F_DQ_CSV, DS13F_HOLDINGS_MD]) { const t = (await fs.readFile(P(f), "utf8")).split("\n"); console.log(`\n[테스트 모드 출력] ${path.basename(f)} (${t.length - 1}줄, 앞 14줄 + 마지막 4줄)\n${[...t.slice(0, 14), ...(t.length > 18 ? ["..."] : []), ...t.slice(-5)].join("\n").slice(0, 6000)}`); }
  if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `### DS13 포워드 관찰\n\n${summary}\n`);
}
