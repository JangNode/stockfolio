/**
 * [임시 연구 — 병합 금지] 연구 A·B 공용 게이트 판정·보고(실행 파일 아님). 게이트 A~H 정의는 docs/research/f-daily-trend-prereg.md 구현 세부 9,
 * r-allcap-fundamentals-prereg.md 단계 2의 정의를 그대로 옮겼다(완화 없음). 사전 등록: a-pref-spread-prereg.md, b-lowvol-quality-prereg.md.
 */
import type { SimRun, SimTrade } from "@/lib/slotSim";
import { F_A_EXCESS_PP, F_C_MAX_CAGR_DROP, F_C_MAX_MDD_WORSEN, F_E_TOP_TRADES, F_F_MIN_PCTILE, KSS_R3_DRAWS, KSS_R3_SEED, KSS32_SEEDS_WON, KSS31_PRACTICAL_FROM, R_ORDER_RATIO_FLAG } from "@/lib/kodexSectorSatConfig";
import { SAT_MDD_EPS } from "@/lib/satelliteV1Config";
import { A_MIN_ENTRIES } from "@/lib/prefSpreadConfig";
import { B_AB_MDD_MARGIN_PP } from "@/lib/lowvolMomentumConfig";
import { avg, median, f2, ox, mulberry32, type Harness, type Win, type Ser } from "./researchHarness";

export interface RunOpts { lag: number; int?: number; replace?: Set<string>; detail?: boolean; exclude?: Set<string> }
export interface CandSpec {
  id: string; trial: number; title: string; defense: boolean; capFrac: number;
  run: (o: RunOpts) => SimRun;
  neighbors: { label: string; run: () => SimRun }[];
  /** 게이트 F: 신호일(판단일 인덱스)별 실제 진입 주문 수로 무작위 후보를 뽑아 같은 청산·크기 규칙으로 돌린다. */
  random: (rng: () => number, ordersByDay: Map<number, number>) => SimRun;
  reasons: string[];
  label: (code: string) => string;
  fDenominator: number;
  extra?: (base: SimRun) => void;
}
export interface Windows { NW: [string, Win][]; FULL: Win; ALL: [string, Win][] }
export interface Verdict { id: string; trial: number; gates: Record<string, boolean | null>; ref: { A: boolean }; pass: boolean; fail: string[]; run: SimRun; full: { cagr: number; mdd: number } }

export function makeWindows(h: Harness, evalFromIdx: number): Windows {
  const from = h.CAL[evalFromIdx];
  const NW: [string, Win][] = [["학습 2011~2016", { from, to: "2016-12-31" }], ["확인 2017~2021", { from: "2017-01-01", to: "2021-12-31" }], ["보류 2022~", { from: "2022-01-01", to: "9999-12-31" }]];
  const FULL: Win = { from, to: "9999-12-31" };
  return { NW, FULL, ALL: [...NW, ["평가 구간 전체", FULL]] };
}

const retOf = (t: SimTrade): number => t.proceeds / t.spend - 1;
const pnlOf = (t: SimTrade): number => (t.proceeds - t.spend) / t.vAtEntry;

export function evaluate(h: Harness, W: Windows, spec: CandSpec): Verdict {
  const { CAL, nCal } = h;
  const { NW, FULL, ALL } = W;
  const eps = SAT_MDD_EPS;
  console.log(`\n##### ${spec.id} (시험 ${spec.trial}) — ${spec.title} #####`);
  const o = spec.run({ lag: 1, detail: true });
  const full = h.st(o, FULL), bhFull = h.st(h.bhP, FULL);
  console.log(`| 구간 | CAGR % | MDD % | 최악 12개월 % | 샤프 | 069500 원주가 CAGR / MDD | B 조건 |\n|---|---|---|---|---|---|---|`);
  let bCount = 0;
  for (const [name, win] of ALL) {
    const s = h.st(o, win), b = h.st(h.bhP, win);
    const okB = s.cagr > b.cagr && s.mdd <= b.mdd + eps;
    if (win !== FULL && okB) bCount++;
    console.log(`| ${name} | ${f2(s.cagr)} | ${f2(s.mdd)} | ${f2(h.worst12(o, win))} | ${f2(s.sharpe)} | ${f2(b.cagr)} / ${f2(b.mdd)} | ${win === FULL ? "-" : ox(okB)} |`);
  }
  const ex26 = { from: FULL.from, to: "2025-12-31" };
  const s26 = h.st(o, ex26), b26 = h.st(h.bhP, ex26);
  console.log(`2026년 제외(${ex26.from}~${ex26.to}): ${spec.id} CAGR ${f2(s26.cagr)} / MDD ${f2(s26.mdd)} | 069500 ${f2(b26.cagr)} / ${f2(b26.mdd)}`);

  // 거래 통계
  const closedIn = (win: Win): SimTrade[] => o.trades.filter((t) => CAL[t.exitC] >= win.from && CAL[t.exitC] <= win.to);
  console.log(`${spec.id} 거래 통계(닫힌 거래, 구간은 청산 실행일 기준; 기간 끝에 열려 있는 거래는 제외)\n| 구간 | 진입 건수 | 청산 건수 | 승률 % | 손익비 | 보유일 중앙값 | 평균 보유일 전체 / 이긴 / 진 |\n|---|---|---|---|---|---|---|`);
  const hold = (t: SimTrade): number => t.exitC - t.entryC;
  for (const [name, win] of ALL) {
    const cl = closedIn(win), w = cl.filter((t) => retOf(t) > 0), l = cl.filter((t) => retOf(t) <= 0);
    const nEnt = o.entryCs.filter((c) => CAL[c] >= win.from && CAL[c] <= win.to).length;
    const avgW = avg(w.map(retOf)), avgL = avg(l.map((t) => -retOf(t)));
    console.log(`| ${name} | ${nEnt} | ${cl.length} | ${f2((w.length / Math.max(cl.length, 1)) * 100)} | ${w.length && l.length ? f2(avgW / avgL) : "-"} | ${f2(median(cl.map(hold)))} | ${f2(avg(cl.map(hold)))} / ${f2(avg(w.map(hold)))} / ${f2(avg(l.map(hold)))} |`);
  }
  console.log(`청산 사유별 건수: ${ALL.map(([n, w]) => { const cl = closedIn(w); return `${n}: ${spec.reasons.map((r) => `${r} ${cl.filter((t) => t.reason === r).length}`).filter((x) => !x.endsWith(" 0")).join(" / ") || "-"}`; }).join(" | ")}`);
  const stopN = o.trades.filter((t) => t.reason.startsWith("손절")).length;
  console.log(`손절 비율: 닫힌 거래 ${o.trades.length}건 중 손절 ${stopN}건(${f2((stopN / Math.max(o.trades.length, 1)) * 100)}%)`);
  const cl = closedIn(FULL).sort((a, b) => pnlOf(b) - pnlOf(a));
  const tot = cl.reduce((a, t) => a + pnlOf(t), 0), top = cl.slice(0, 10);
  console.log(`${spec.id} 상위 10개 거래(평가 구간 닫힌 ${cl.length}건) 손익 합 = 전 거래 손익 합의 ${f2((top.reduce((a, t) => a + pnlOf(t), 0) / tot) * 100)}% | 상위 거래: ${top.slice(0, 5).map((t) => `${spec.label(t.code)} ${CAL[t.entryC]} ${f2(retOf(t) * 100)}%`).join(", ")}`);
  const byYear = new Map<string, { n: number; pnl: number }>();
  for (const t of cl) { const y = CAL[t.exitC].slice(0, 4); const e = byYear.get(y) ?? { n: 0, pnl: 0 }; e.n++; e.pnl += pnlOf(t); byYear.set(y, e); }
  console.log(`연도별 닫힌 거래(청산 연도) 건수 / 손익 기여(진입 시 계좌 대비 %의 합): ${[...byYear].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([y, e]) => `${y} ${e.n}건 ${f2(e.pnl * 100)}`).join(" | ")}`);
  console.log(`거래정지·상폐: 진입 체결일 거래량 0으로 건너뛴 후보 ${o.haltSkip}건 | 청산 체결일 거래량 0으로 순연된 청산 ${o.exitDefer}건 | 상폐 청산 ${o.trades.filter((t) => t.reason === "폐지").length}건`);

  // 보유·투자 비중 + 같은 평균 투자 비중의 069500 + 현금(정보용, 판정 불사용)
  console.log(`${spec.id} 보유·투자 비중·비용\n| 구간 | 평균 보유 종목 수 | 현금 100% 비율 % | 평균 투자 비중 % | 연 회전율 % | 연 비용 % | 같은 평균 투자 비중의 069500+현금 CAGR / MDD(정보용) |\n|---|---|---|---|---|---|---|`);
  for (const [name, win] of ALL) {
    const s = h.st(o, win);
    const idx: number[] = [];
    for (let i = 0; i < o.dates.length; i++) if (o.dates[i] >= win.from && o.dates[i] <= win.to) idx.push(i);
    const cash100 = idx.filter((i) => o.nPos[i] === 0).length / Math.max(idx.length, 1) * 100;
    const wbar = s.avgInv / 100;
    const mixed: Ser = { dates: h.bhP.dates, ret: h.bhP.ret.map((r) => r * wbar) };
    const sm = h.st(mixed, win);
    console.log(`| ${name} | ${f2(s.avgN)} | ${f2(cash100)} | ${f2(s.avgInv)} | ${f2(s.turnover)} | ${f2(s.cost)} | ${f2(sm.cagr)} / ${f2(sm.mdd)} |`);
  }
  console.log(`단일 종목 최대 비중(보유 있는 날) 평균 ${f2(avg(o.wMax.filter(Number.isFinite)) * 100)}% / 최대 ${f2(Math.max(...o.wMax.filter(Number.isFinite)) * 100)}%`);

  // 게이트
  const gA = full.cagr >= bhFull.cagr + F_A_EXCESS_PP && full.mdd <= bhFull.mdd + eps;
  const gAB = full.cagr >= bhFull.cagr && full.mdd <= bhFull.mdd - B_AB_MDD_MARGIN_PP + eps;
  const gB = bCount >= 2;
  const od = spec.run({ lag: 2 });
  const fullD = h.st(od, FULL);
  const gC = full.cagr - fullD.cagr <= F_C_MAX_CAGR_DROP && fullD.mdd - full.mdd <= F_C_MAX_MDD_WORSEN;
  console.log(`지연 버전(진입·청산 +1일) 평가 구간 CAGR ${f2(fullD.cagr)} (하락 ${f2(full.cagr - fullD.cagr)}%p) / MDD ${f2(fullD.mdd)} (악화 ${f2(fullD.mdd - full.mdd)}%p)`);
  let gD = true;
  console.log(`D 이웃값 ${spec.neighbors.length}개(평가 구간 CAGR ≥ 069500 원주가 ${f2(bhFull.cagr)})\n| 변형 | 평가 구간 CAGR % | MDD % | 판정 |\n|---|---|---|---|`);
  for (const nb of spec.neighbors) { const s = h.st(nb.run(), FULL); const ok = s.cagr >= bhFull.cagr; if (!ok) gD = false; console.log(`| ${nb.label} | ${f2(s.cagr)} | ${f2(s.mdd)} | ${ox(ok)} |`); }
  const top3 = [...o.trades.filter((t) => CAL[t.exitC] >= FULL.from)].sort((a, b) => pnlOf(b) - pnlOf(a)).slice(0, F_E_TOP_TRADES);
  const rep = new Set(top3.map((t) => `${t.code}|${t.entryC}`));
  const r2c = h.st(spec.run({ lag: 1, replace: rep }), FULL).cagr, gE = r2c >= bhFull.cagr;
  console.log(`E: 상위 3개 거래(${top3.map((t) => `${spec.label(t.code)} ${CAL[t.entryC]}~${CAL[t.exitC]} 수익률 ${f2(retOf(t) * 100)}%`).join(", ")})를 069500 원주가 수익률로 대체 → 평가 구간 CAGR ${f2(r2c)} (기준 ${f2(bhFull.cagr)}) ${ox(gE)}`);
  const ordersByDay = new Map<number, number>();
  for (const c of o.entryCs) ordersByDay.set(c - 1, (ordersByDay.get(c - 1) ?? 0) + 1);
  const rng = mulberry32(KSS_R3_SEED);
  const draws: number[] = [];
  for (let k = 0; k < KSS_R3_DRAWS; k++) draws.push(h.st(spec.random(rng, ordersByDay), FULL).cagr);
  const pct = (draws.filter((x) => x < full.cagr).length / draws.length) * 100;
  const gF = pct >= F_F_MIN_PCTILE;
  const sd = [...draws].sort((a, b) => a - b);
  console.log(`F 무작위 진입일(같은 신호 건수 ${o.entryCs.length}건) ${KSS_R3_DRAWS}회(시드 ${KSS_R3_SEED}): 중앙값 ${f2(sd[Math.floor(sd.length / 2)])}, 95분위 ${f2(sd[Math.floor(sd.length * 0.95)])}, 최대 ${f2(sd[sd.length - 1])}, ${spec.id} ${f2(full.cagr)} → 백분위 ${f2(pct)} | 참고 1−0.05/${spec.fDenominator} = ${f2(100 * (1 - 0.05 / spec.fDenominator))} 이상 ${ox(pct >= 100 * (1 - 0.05 / spec.fDenominator))}`);
  const nEnt = o.entryCs.filter((c) => CAL[c] >= FULL.from).length;
  const gG = nEnt >= A_MIN_ENTRIES;
  const gates: Record<string, boolean | null> = { [spec.defense ? "A_B" : "A"]: spec.defense ? gAB : gA, B: gB, C: gC, D: gD, E: gE, F: gF, G: gG, H: null };
  const fail = Object.entries(gates).filter(([, v]) => v === false).map(([k]) => k);
  const pass = fail.length === 0;
  console.log(`${spec.id} 게이트: ${spec.defense ? `A_B ${ox(gAB)}(참고 A ${ox(gA)})` : `A ${ox(gA)}`} | B ${ox(gB)}(${bCount}개 구간) | C ${ox(gC)} | D ${ox(gD)} | E ${ox(gE)} | F ${ox(gF)} | G ${ox(gG)}(진입 ${nEnt}건, 기준 ${A_MIN_ENTRIES}) | H 해당 없음 → ${pass ? "통과" : `탈락(${fail.join(", ")})`}`);
  spec.extra?.(o);
  return { id: spec.id, trial: spec.trial, gates, ref: { A: gA }, pass, fail, run: o, full: { cagr: full.cagr, mdd: full.mdd } };
}

export function seedReport(h: Harness, W: Windows, specs: CandSpec[], runs: Map<string, SimRun>, byAvgTv: (code: string, c: number) => number): void {
  const { CAL } = h;
  console.log(`\n=== 시드 정수 주 모의 (진입 비중 고정, 남는 돈은 현금, 1주도 못 사면 다음 후보; 평가 구간 ${W.FULL.from}~) ===\n| 후보 | 시드 | ${W.ALL.map(([n]) => `${n} CAGR / MDD`).join(" | ")} | 최종 평가액(원) | 평균 보유 종목 수(전체 날 / 보유 있는 날) |\n|---|---|${W.ALL.map(() => "---").join("|")}|---|---|`);
  const seedRuns = new Map<string, SimRun>();
  for (const sp of specs) {
    for (const seed of KSS32_SEEDS_WON) {
      const o = sp.run({ lag: 1, int: seed });
      if (seed === 10_000_000) seedRuns.set(sp.id, o);
      const cells = W.ALL.map(([, win]) => { const s = h.st(o, win); return `${f2(s.cagr)} / ${f2(s.mdd)}`; });
      let V = seed;
      for (const r of o.ret) V *= 1 + r / 100;
      console.log(`| ${sp.id} | ${(seed / 10_000).toLocaleString("ko-KR")}만 원 | ${cells.join(" | ")} | ${Math.round(V).toLocaleString("ko-KR")} | ${f2(avg(o.nPos))} / ${f2(avg(o.nPos.filter((n) => n > 0)))} |`);
    }
  }
  console.log(`\n=== 최소 필요 금액(1주를 살 수 있는 계좌 = 진입일 원 종가 ÷ 진입 비중; ${KSS31_PRACTICAL_FROM} 이후 진입) ===\n| 후보 | 진입 건수 | 중앙값(원) | 최대(원) | 가장 최근 진입일 | 최근 값(원) | 종목 |\n|---|---|---|---|---|---|---|`);
  for (const sp of specs) {
    const o = runs.get(sp.id)!;
    const all = [...o.trades].sort((a, b) => a.entryC - b.entryC).filter((t) => CAL[t.entryC].slice(0, 7) >= KSS31_PRACTICAL_FROM);
    if (!all.length) { console.log(`| ${sp.id} | 0 | - | - | - | - | - |`); continue; }
    const v = all.map((t) => t.entryRaw / sp.capFrac), l = all[all.length - 1];
    console.log(`| ${sp.id} | ${all.length} | ${Math.round(median(v)).toLocaleString("ko-KR")} | ${Math.round(Math.max(...v)).toLocaleString("ko-KR")} | ${CAL[l.entryC]} | ${Math.round(l.entryRaw / sp.capFrac).toLocaleString("ko-KR")} | ${sp.label(l.code)} |`);
  }
  console.log(`\n=== 체결 가능성: 시드 1,000만 원 정수 주 모의의 진입 금액 ÷ 진입일 20일 평균 거래대금 ===\n| 후보 | 진입 건수 | 중앙값 % | 95분위 % | 최대 % | > ${R_ORDER_RATIO_FLAG * 100}% 건수 (비율 %) |\n|---|---|---|---|---|---|`);
  for (const sp of specs) {
    const o = seedRuns.get(sp.id);
    if (!o) continue;
    const rs: number[] = [];
    for (const t of o.trades) { const tv = byAvgTv(t.code, t.entryC); if (tv > 0) rs.push((t.spend / tv) * 100); }
    rs.sort((a, b) => a - b);
    const over = rs.filter((x) => x > R_ORDER_RATIO_FLAG * 100).length;
    console.log(`| ${sp.id} | ${rs.length} | ${f2(rs[Math.floor(rs.length / 2)] ?? NaN)} | ${f2(rs[Math.floor(rs.length * 0.95)] ?? NaN)} | ${f2(rs[rs.length - 1] ?? NaN)} | ${over} (${f2((over / Math.max(rs.length, 1)) * 100)}) |`);
  }
}

export function yearlyTable(h: Harness, W: Windows, runs: { id: string; run: SimRun }[]): void {
  const years: number[] = [];
  for (let y = Number(W.FULL.from.slice(0, 4)); y <= Number(h.dataEnd.slice(0, 4)); y++) years.push(y);
  console.log(`\n=== 연도별 수익률 % (해당 연도 일수익률 복리; ${years[0]}년은 ${W.FULL.from}부터) ===\n| 구성 | ${years.join(" | ")} |\n|---|${years.map(() => "---").join("|")}|`);
  console.log(`| 069500 원주가 | ${years.map((y) => f2(h.yearRet({ dates: h.bhP.dates.filter((d) => d >= W.FULL.from), ret: h.bhP.ret.filter((_, i) => h.bhP.dates[i] >= W.FULL.from) }, y))).join(" | ")} |`);
  for (const r of runs) console.log(`| ${r.id} | ${years.map((y) => f2(h.yearRet(r.run, y))).join(" | ")} |`);
}

export function summaryReport(verdicts: Verdict[], doneTrials: number[]): void {
  console.log(`\n=== 요약 ===\n| 후보(시험) | A 또는 A_B | (참고 A) | B | C | D | E | F | G | H | 결과 | 탈락 사유 |\n|---|---|---|---|---|---|---|---|---|---|---|---|`);
  for (const v of verdicts) {
    const g = (k: string): string => (v.gates[k] === undefined || v.gates[k] === null ? "-" : ox(v.gates[k] as boolean));
    const aKey = v.gates.A_B !== undefined ? "A_B" : "A";
    console.log(`| ${v.id} (${v.trial}) | ${g(aKey)} | ${ox(v.ref.A)} | ${g("B")} | ${g("C")} | ${g("D")} | ${g("E")} | ${g("F")} | ${g("G")} | 해당 없음 | ${v.pass ? "통과" : "탈락"} | ${v.fail.join(", ") || "-"} |`);
  }
  const cum = 203 + doneTrials.length;
  console.log("경고(홀드아웃 오염): 보류 구간(2022~)은 이미 여러 번 본 데이터이고 학습·확인 구간도 앞선 연구들에서 반복해 본 구간이라 순수 검증이 아니다.");
  console.log(`경고(우연 통과): 누적 시험 ${cum}번 중 실력이 없어도 5% 수준 기준 하나를 우연히 넘는 후보가 평균 ${cum} × 0.05 = ${(cum * 0.05).toFixed(2)}개 나올 것으로 기대되고, 적어도 하나가 걸릴 확률은 1 − 0.95^${cum} = ${f2((1 - Math.pow(0.95, cum)) * 100)}% (시험들이 독립이 아니므로 근사). (A+B 4건 모두 실행 시 207번)`);
  console.log("통과 여부와 무관하게 운영 적용·PR 생성은 하지 않고 보고만 한다.");
}
