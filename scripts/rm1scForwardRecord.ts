/**
 * [임시 연구 — 병합 금지, 읽기 전용] RM1SC(코어 40% + RM1S 60%) 포워드 기록. DS13 포워드 기록(ds13ForwardRecord.ts)이 호출한다. 정의 동결: docs/research/rm1sc-forward-freeze.md.
 * 계산 코드는 lib/ds13Engine.ts(mkRMS·rm1scOf; 시험 코드 research-batch5.ts 도 같은 코드를 쓴다). 가격 데이터만 쓰고 DB·Storage 쓰기 0, 외부 요청 0, 공시 사용 없음.
 * 검증 단계: 고정 스냅샷에서 RM1SC 기록값(포워드 데이터 표준, 13.38 / 34.87)을 재현하지 못하면 중단한다. 관찰 단계: 일별 가상 수익(069500·DS6·DS13L·DS13M과 한 표), 일별 상태(RM1S 보유·진입 후 최고 종가·손절 플래그), 월말 후보·목표 비중(추가만), 손절 사후 점검(추가만).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { makeDs13Engine } from "@/lib/ds13Engine";
import { RM1SCF_START_AFTER, RM1SCF_REC_FULL, RM1SCF_REC_W1, RM1SCF_LOG_CSV, RM1SCF_STATE_CSV, RM1SCF_SIGNALS_CSV, RM1SCF_STOPS_CSV, RM1SCF_LOG_HEADER, RM1SCF_STATE_HEADER, RM1SCF_SIGNALS_HEADER, RM1SCF_STOPS_HEADER, RM1SCF_POST_DAYS, RM1SCF_CAND_DEPTH } from "@/lib/rm1scForwardConfig";
import { RM1S_P0 } from "@/lib/stopConfig";
import { f2, type Harness, type S, type Win } from "./researchHarness";
import type { Windows } from "./researchGates";

type Engine = ReturnType<typeof makeDs13Engine>;
type Run = { dates: string[]; ret: number[] };
export interface Rm1scArgs {
  h: Harness; E: Engine; W13: Windows; cS13: number; from: string; fixedDate: string; forward: boolean;
  dL: { base: { res: { run: Run } } }; dM: { base: { res: { run: Run } } }; ds6: Run;
  closes: Map<string, { px: number; src: string }>; nameOf: (code: string) => string; startAfter?: string; outDir?: string;
}
const readLines = async (file: string): Promise<string[]> => { try { return (await fs.readFile(file, "utf8")).split(/\r?\n/).filter((l) => l.trim() !== ""); } catch { return []; } };

export async function rm1scPhase(a: Rm1scArgs): Promise<void> {
  const { h, E, W13, cS13, from, fixedDate, forward, dL, dM, ds6, nameOf } = a;
  const { CAL, nCal } = h;
  const START = a.startAfter ?? RM1SCF_START_AFTER;
  const P = (f: string): string => (a.outDir ? path.join(a.outDir, path.basename(f)) : f);
  const T = Date.now();
  // ---- 상태 수집 훅(관찰 단계): 신호일 c 종가 시점의 보유·진입 후 최고 종가·손절 플래그, 월말 선정 종목 ----
  const stateRows = new Map<number, { code: string; peak: number; stopped: boolean }[]>(), meSel = new Map<number, ReadonlySet<string>>();
  const startC0 = CAL.findIndex((d) => d >= START), startC = startC0 < 0 ? nCal : startC0; // 기준일에 아직 데이터가 닿지 않았으면 상태를 모으지 않는다
  const sc = E.rm1scOf(cS13, W13, forward ? { onDay: (c, info) => { if (c < startC) return; stateRows.set(c, [...info.held].map((code) => ({ code, peak: info.peak.get(code) as number, stopped: info.stopped.has(code) }))); if (info.sel) meSel.set(c, new Set(info.sel)); } } : {});
  const events = [...E.rmsLog];
  const run = sc.res.run;

  // ---- 검증: 기록값 재현(포워드 데이터 표준, 고정 스냅샷) ----
  const wFull: Win = { from, to: fixedDate }, wW1: Win = { from, to: "2016-12-29" };
  const sF = h.st(run, wFull), sA = h.st(run, wW1);
  const okF = f2(sF.cagr) === RM1SCF_REC_FULL.cagr && f2(sF.mdd) === RM1SCF_REC_FULL.mdd, okA = f2(sA.cagr) === RM1SCF_REC_W1.cagr && f2(sA.mdd) === RM1SCF_REC_W1.mdd;
  console.log(`\n=== RM1SC 검증: 고정 구간 재계산 vs 기록값 (CAGR % / MDD %, 포워드 데이터 표준 = 보정만) ===\n| 구간 | 이번 계산 | 기록값 | 판정 |\n|---|---|---|---|\n| ${from}~2016-12-29 | ${f2(sA.cagr)} / ${f2(sA.mdd)} | ${RM1SCF_REC_W1.cagr} / ${RM1SCF_REC_W1.mdd} | ${okA ? "일치" : "불일치"} |\n| ${from}~${fixedDate} | ${f2(sF.cagr)} / ${f2(sF.mdd)} | ${RM1SCF_REC_FULL.cagr} / ${RM1SCF_REC_FULL.mdd} | ${okF ? "일치" : "불일치"} |`);
  if (!okF || !okA) throw new Error("RM1SC 고정 구간 재계산이 기록값과 다르다 — 관찰 단계로 넘어가지 않고 멈춘다. 보고한다");
  if (!forward) { console.log(`\nRM1SC 검증 단계 통과 | 소요 ${((Date.now() - T) / 1000).toFixed(0)}초`); return; }

  // ---- 관찰 단계 ----
  const bMap = new Map(h.bhP.dates.map((d, i) => [d, h.bhP.ret[i]]));
  const idx = (r: Run): Map<string, number> => new Map(r.dates.map((d, i) => [d, i]));
  const iS = idx(run), iL = idx(dL.base.res.run), iM = idx(dM.base.res.run), i6 = idx(ds6);
  const obs: string[] = [];
  for (const d of run.dates) { if (d <= START) continue; if (!bMap.has(d)) break; obs.push(d); }
  const cum = { S: 1, L: 1, M: 1, D: 1, B: 1 }, pk = { S: 1, L: 1, M: 1, D: 1, B: 1 }, mdd = { S: 0, L: 0, M: 0, D: 0, B: 0 };
  const evByC = new Map<number, number>();
  for (const e of events) evByC.set(e.c, (evByC.get(e.c) ?? 0) + 1);
  const logRows: string[][] = [], stateOut: string[] = [];
  for (const d of obs) {
    const ix = iS.get(d) as number, c = h.calIdx.get(d) as number;
    const rS = run.ret[ix], rL = dL.base.res.run.ret[iL.get(d) as number], rM = dM.base.res.run.ret[iM.get(d) as number], r6 = ds6.ret[i6.get(d) as number], rb = bMap.get(d) as number;
    const cl = a.closes.get(d);
    if (!cl) throw new Error(`${d} 069500 원주가 종가 기록이 없다`);
    const rs: [keyof typeof cum, number][] = [["S", rS], ["L", rL], ["M", rM], ["D", r6], ["B", rb]];
    const cumS: string[] = [], ddS: string[] = [];
    for (const [k, r] of rs) { cum[k] *= 1 + r / 100; pk[k] = Math.max(pk[k], cum[k]); const dd = (cum[k] / pk[k] - 1) * 100; mdd[k] = Math.min(mdd[k], dd); cumS.push(((cum[k] - 1) * 100).toFixed(4)); ddS.push(dd.toFixed(4)); }
    const w = sc.res.wEnd[ix];
    logRows.push([d, rS.toFixed(4), rL.toFixed(4), rM.toFixed(4), r6.toFixed(4), rb.toFixed(4), ...cumS, ...ddS, sc.sls[0].ret[ix].toFixed(4), w[0].toFixed(5), sc.sls[1].ret[ix].toFixed(4), w[1].toFixed(5), ((1 - sc.sls[1].inv[ix]) * 100).toFixed(3), String(sc.sls[1].nPos[ix]), String(evByC.get(c) ?? 0), String(cl.px), cl.src]);
    for (const r of [...(stateRows.get(c) ?? [])].sort((x, y) => (x.code < y.code ? -1 : 1))) {
      const s = h.byCode.get(r.code) as S, i = s.idx.get(d);
      if (i === undefined) continue;
      stateOut.push([d, r.code, nameOf(r.code), s.close[i].toFixed(4), String(s.raw[i]), r.peak.toFixed(4), ((s.close[i] / r.peak - 1) * 100).toFixed(3), r.stopped ? "1" : "0", (r.peak * (1 - RM1S_P0.stop)).toFixed(4)].join(","));
    }
  }
  // 일별 가상 수익 로그·상태 로그: 실행마다 시뮬레이션에서 다시 쓰고 이전 기록과 달라진 행 수를 센다(DS13 로그와 같은 방식)
  const prev = new Map<string, string>();
  { const ls = await readLines(P(RM1SCF_LOG_CSV)); if (ls.length) { if (ls[0] !== RM1SCF_LOG_HEADER) throw new Error(`${RM1SCF_LOG_CSV} 헤더가 기대와 다르다 — 덮어쓰지 않고 중단한다`); for (const l of ls.slice(1)) prev.set(l.split(",")[0], l.split(",").slice(1, 6).join()); } }
  let nChanged = 0;
  for (const r of logRows) { const p = prev.get(r[0]); if (p !== undefined && p !== r.slice(1, 6).join()) nChanged++; }
  await fs.mkdir(path.dirname(P(RM1SCF_LOG_CSV)), { recursive: true });
  await fs.writeFile(P(RM1SCF_LOG_CSV), [RM1SCF_LOG_HEADER, ...logRows.map((r) => r.join(","))].join("\n") + "\n");
  { const ls = await readLines(P(RM1SCF_STATE_CSV)); if (ls.length && ls[0] !== RM1SCF_STATE_HEADER) throw new Error(`${RM1SCF_STATE_CSV} 헤더가 기대와 다르다 — 덮어쓰지 않고 중단한다`); }
  await fs.writeFile(P(RM1SCF_STATE_CSV), [RM1SCF_STATE_HEADER, ...stateOut].join("\n") + "\n");

  // ---- 월말 후보·목표 비중(추가만): 월말 신호일(동결 기준일 포함) 순위 상위 N 후보와 선정(목표 비중) ----
  const sigNew = new Map<string, string[]>();
  for (const [c, sel] of meSel) {
    if (CAL[c] < START || c + 1 >= nCal) continue;
    const key = `${CAL[c]}|${CAL[c + 1]}`, rows: string[] = [];
    const ranked = E.rmSorted(c, RM1S_P0);
    ranked.slice(0, RM1SCF_CAND_DEPTH).forEach((x, k) => { const picked = sel.has(x.code); rows.push(`${CAL[c]},${CAL[c + 1]},${k + 1},${x.code},${nameOf(x.code)},${x.sc.toFixed(4)},${picked ? 1 : 0},${picked ? (100 / RM1S_P0.n).toFixed(3) : ""},${picked ? ((100 / RM1S_P0.n) * 0.6).toFixed(3) : ""},RM1 점수 순위 후보(유지 순위 ${RM1S_P0.n * RM1S_P0.keepMult})`); });
    for (const code of sel) if (!ranked.slice(0, RM1SCF_CAND_DEPTH).some((x) => x.code === code)) rows.push(`${CAL[c]},${CAL[c + 1]},,${code},${nameOf(code)},,1,${(100 / RM1S_P0.n).toFixed(3)},${((100 / RM1S_P0.n) * 0.6).toFixed(3)},선정(후보 상위 ${RM1SCF_CAND_DEPTH}위 밖, 보유 유지 또는 순위 변동)`);
    sigNew.set(key, rows);
  }
  const sigOld = await readLines(P(RM1SCF_SIGNALS_CSV));
  if (sigOld.length && sigOld[0] !== RM1SCF_SIGNALS_HEADER) throw new Error(`${RM1SCF_SIGNALS_CSV} 헤더가 기대와 다르다 — 덮어쓰지 않고 중단한다`);
  const oldGroups = new Map<string, string[]>();
  for (const l of sigOld.slice(1)) { const c = l.split(","); (oldGroups.get(`${c[0]}|${c[1]}`) ?? oldGroups.set(`${c[0]}|${c[1]}`, []).get(`${c[0]}|${c[1]}`) as string[]).push(l); }
  let sigAdded = 0, sigChanged = 0;
  const finalSig: string[] = [...oldGroups.values()].flat();
  for (const [k, g] of sigNew) { const o = oldGroups.get(k); if (!o) { finalSig.push(...g); sigAdded++; } else if ([...o].sort().join("\n") !== [...g].sort().join("\n")) sigChanged++; }
  finalSig.sort((x, y) => { const a = x.split(","), b = y.split(","); return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : (Number(a[2]) || 999) - (Number(b[2]) || 999) || (a[3] < b[3] ? -1 : 1); }); // 신호일 → 순위 순
  await fs.writeFile(P(RM1SCF_SIGNALS_CSV), [RM1SCF_SIGNALS_HEADER, ...finalSig].join("\n") + "\n");

  // ---- 손절 사후 점검(추가만): 발동 행(trigger)과 21거래일 경과 행(after21)을 따로 추가 ----
  const stopsOld = await readLines(P(RM1SCF_STOPS_CSV));
  if (stopsOld.length && stopsOld[0] !== RM1SCF_STOPS_HEADER) throw new Error(`${RM1SCF_STOPS_CSV} 헤더가 기대와 다르다 — 덮어쓰지 않고 중단한다`);
  const keys = new Set(stopsOld.slice(1).map((l) => { const c = l.split(","); return `${c[0]}|${c[1]}|${c[3]}`; }));
  const stopsNew: string[] = [];
  for (const e of events) {
    if (CAL[e.c] < START || e.c + 1 >= nCal) continue;
    const s = h.byCode.get(e.code) as S, f = e.c + 1, ie = s.idx.get(CAL[e.c]), ix = s.idx.get(CAL[f]), al = E.al(s);
    const pkv = (stateRows.get(e.c) ?? []).find((r) => r.code === e.code)?.peak;
    const base = [CAL[e.c], CAL[f], e.code, nameOf(e.code), pkv !== undefined ? pkv.toFixed(4) : "", ie !== undefined ? s.close[ie].toFixed(4) : "", ix !== undefined ? s.close[ix].toFixed(4) : "", ix !== undefined ? String(s.raw[ix]) : ""];
    if (!keys.has(`trigger|${CAL[e.c]}|${e.code}`)) stopsNew.push(["trigger", ...base, "", ""].join(","));
    const g = f + RM1SCF_POST_DAYS;
    if (g < nCal && al[f] > 0 && al[g] > 0 && !keys.has(`after21|${CAL[e.c]}|${e.code}`)) stopsNew.push(["after21", ...base, ((al[g] / al[f] - 1) * 100).toFixed(3), CAL[g]].join(","));
  }
  await fs.writeFile(P(RM1SCF_STOPS_CSV), [RM1SCF_STOPS_HEADER, ...stopsOld.slice(1), ...stopsNew].join("\n") + "\n");

  const last = logRows[logRows.length - 1];
  console.log(`\n=== RM1SC 포워드 관찰(${START} 종가 = 100, 다음 거래일부터) 마지막 10일 ===\n| 날짜 | RM1SC 일 % | DS13L 일 % | DS13M 일 % | DS6 일 % | 069500 일 % | RM1SC 누적 | DS13L 누적 | DS13M 누적 | DS6 누적 | 069500 누적 | RM1S 현금 % | 보유 | 손절 |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|`);
  for (const r of logRows.slice(-10)) console.log(`| ${r[0]} | ${r[1]} | ${r[2]} | ${r[3]} | ${r[4]} | ${r[5]} | ${r[6]} | ${r[7]} | ${r[8]} | ${r[9]} | ${r[10]} | ${r[20]} | ${r[21]} | ${r[22]} |`);
  console.log(last
    ? `RM1SC 포워드 ${logRows[0][0]}~${last[0]}(${logRows.length}거래일): 누적 % RM1SC ${last[6]} / DS13L ${last[7]} / DS13M ${last[8]} / DS6 ${last[9]} / 069500 ${last[10]} | 최저 낙폭 % RM1SC ${mdd.S.toFixed(2)} / DS13L ${mdd.L.toFixed(2)} / DS13M ${mdd.M.toFixed(2)} / DS6 ${mdd.D.toFixed(2)} / 069500 ${mdd.B.toFixed(2)}`
    : `RM1SC 포워드: 기록 구간 0거래일(${START} 이후 069500 등 모든 계열이 있는 거래일 없음)`);
  console.log(`월말 후보·목표 비중 기록: 기존 그룹 ${oldGroups.size}개 + 신규 ${sigAdded}개, 달라진 그룹 ${sigChanged}개${sigChanged ? " — 경고: 소급 수정하지 않고 기존 기록을 유지했다" : ""} | 손절 사후 점검: 신규 ${stopsNew.length}행(발동 ${stopsNew.filter((l) => l.startsWith("trigger")).length}, 21거래일 경과 ${stopsNew.filter((l) => l.startsWith("after21")).length}) | 이전 로그와 일수익이 달라진 행 ${nChanged}개 | 로그 ${RM1SCF_LOG_CSV} ${logRows.length}행, 상태 ${stateOut.length}행 | 소요 ${((Date.now() - T) / 1000).toFixed(0)}초`);
  if (a.outDir) for (const f of [RM1SCF_LOG_CSV, RM1SCF_STATE_CSV, RM1SCF_SIGNALS_CSV, RM1SCF_STOPS_CSV]) { const t = (await fs.readFile(P(f), "utf8")).split("\n"); console.log(`\n[테스트 모드 출력] ${path.basename(f)} (${t.length - 1}줄, 앞 8줄 + 마지막 3줄)\n${[...t.slice(0, 8), ...(t.length > 12 ? ["..."] : []), ...t.slice(Math.max(8, t.length - 4))].join("\n")}`); }
  if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `### RM1SC 포워드 관찰\n\n${last ? `${logRows[0][0]}~${last[0]}(${logRows.length}거래일) 누적 % RM1SC ${last[6]} / DS13L ${last[7]} / DS13M ${last[8]} / DS6 ${last[9]} / 069500 ${last[10]}` : "기록 구간 0거래일"}\n`);
}
