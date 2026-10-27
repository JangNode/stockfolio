/**
 * [임시 연구 — 병합 금지] 연구 A·B 공용 일별 슬롯 시뮬레이터(순수 함수, I/O 없음).
 * scripts/research-r-allcap.ts의 simR(M3 틀)에서 청산·후보 규칙만 훅으로 빼고 나머지(슬롯·비용·실행 순서·폐지·거래정지 처리·시드 정수 주·대체 거래)는 그대로 옮겼다.
 * 사전 등록: docs/research/a-pref-spread-prereg.md, docs/research/b-lowvol-quality-prereg.md
 */

export interface SimS { code: string; dates: string[]; idx: Map<string, number>; close: Float64Array; raw: Float64Array; vol: Float64Array; last: string }
export interface SimCand { s: SimS; code: string }
export interface SimPos { code: string; s: SimS; shares: number; lastPx: number; entryC: number; entryAdj: number; entryRaw: number; peak: number; spend: number; vAtEntry: number; ev: number; rep: boolean; repVal: number; exitSched: boolean }
export interface SimTrade { code: string; entryC: number; exitC: number; spend: number; proceeds: number; vAtEntry: number; reason: string; entryAdj: number; peakAdj: number; exitAdj: number; entryRaw: number }
export interface SimRun { dates: string[]; ret: number[]; costFrac: number[]; nPos: number[]; inv: number[]; turn: { d: string; v: number }[]; trades: SimTrade[]; entryCs: number[]; wMax: number[]; haltSkip: number; exitDefer: number }
export interface SimEnv {
  CAL: string[]; nCal: number; cS: number;
  adjustments: Map<string, { eventDate: string; factor: number }[]>;
  endedBefore: string;
  /** computeEffectiveBuyPrice(1) — 수수료와 기본 슬리피지(baseSlip)를 포함한 매수 배수 */
  stockBuyMult: number;
  /** 1 − computeEffectiveSellPrice(1, d, "KR") — 수수료·거래세·기본 슬리피지를 포함한 매도 비용률 */
  sellRate: (d: string) => number;
  baseSlip: number;
  /** 069500 원주가 일수익률(소수), 대체 거래용 */
  bhRet: Map<string, number>;
}
export interface SimCfg { slip: number; maxPos: number; capFrac: number; cooldown: number }
export interface SimHooks<C extends SimCand> {
  /** 판단일 c의 진입 후보(우선순위 순). 보유·쿨다운 필터는 엔진이 한다. */
  candsOf: (c: number, held: (code: string) => boolean, blocked: (code: string) => boolean) => C[];
  /** 판단일 c(종가)의 보유 종목 청산 사유(없으면 null). i = 판단일 보유 종목의 행 번호(그날 행이 없으면 undefined). */
  exitReason: (p: SimPos, c: number, i: number | undefined) => string | null;
}
export interface SimOpts {
  lag: number; int?: number; replace?: Set<string>; detail?: boolean;
  /** 보고용: 수익률 집계일마다 계좌 평가액 V와 보유 종목별 평가액을 받는다(시뮬레이션에는 영향 없음). */
  onDay?: (c: number, V: number, held: [string, number][]) => void;
}

export function simSlots<C extends SimCand>(env: SimEnv, cfg: SimCfg, hooks: SimHooks<C>, o: SimOpts): SimRun {
  const { CAL, nCal, cS } = env;
  const int = o.int !== undefined;
  const cap = int ? (o.int as number) : 1;
  const buyMult = (env.stockBuyMult * (1 + cfg.slip)) / (1 + env.baseSlip);
  const sellRateR = (d: string): number => 1 - ((1 - env.sellRate(d)) * (1 - cfg.slip)) / (1 - env.baseSlip);
  const pos = new Map<string, SimPos>();
  const pendExit = new Map<number, Map<string, string>>();
  const pendEnt = new Map<number, { list: C[]; free: number }[]>();
  let reserved = 0, cash = cap, prevV = cap;
  const lastExit = new Map<string, number>();
  const out: SimRun = { dates: [], ret: [], costFrac: [], nPos: [], inv: [], turn: [], trades: [], entryCs: [], wMax: [], haltSkip: 0, exitDefer: 0 };
  const posValue = (p: SimPos): number => (p.rep ? p.repVal : p.shares * p.lastPx);
  const evOf = (code: string): { eventDate: string; factor: number }[] => env.adjustments.get(code) ?? [];
  const closePos = (p: SimPos, c: number, reason: string, adjNow: number, sr: number): number => {
    const val = posValue(p);
    p.peak = Math.max(p.peak, adjNow);
    cash += val * (1 - sr);
    out.trades.push({ code: p.code, entryC: p.entryC, exitC: c, spend: p.spend, proceeds: val * (1 - sr), vAtEntry: p.vAtEntry, reason, entryAdj: p.entryAdj, peakAdj: p.peak, exitAdj: adjNow, entryRaw: p.entryRaw });
    pos.delete(p.code);
    lastExit.set(p.code, c);
    return val;
  };
  for (let c = cS; c < nCal; c++) {
    const d = CAL[c], sr = sellRateR(d);
    let costF = 0, buyN = 0, sellN = 0;
    for (const p of [...pos.values()]) {
      const i = p.s.idx.get(d);
      if (int) { const evs = evOf(p.code); while (p.ev < evs.length && evs[p.ev].eventDate <= d) { p.shares /= evs[p.ev].factor; p.ev++; } }
      if (i !== undefined) { p.lastPx = int ? p.s.raw[i] : p.s.close[i]; if (p.rep) p.repVal *= 1 + (env.bhRet.get(d) ?? 0); }
      else if (p.s.last < d && p.s.last < env.endedBefore) { const v = closePos(p, c, "폐지", p.s.close[p.s.close.length - 1], sr); costF += (v * sr) / prevV; sellN += v; }
    }
    const ex = pendExit.get(c);
    if (ex) {
      pendExit.delete(c);
      for (const [code, reason] of ex) {
        const p = pos.get(code);
        if (!p) continue;
        const i = p.s.idx.get(d);
        if (i === undefined || p.s.vol[i] === 0) { if (i !== undefined) out.exitDefer++; const nx = pendExit.get(c + 1) ?? new Map<string, string>(); nx.set(code, reason); pendExit.set(c + 1, nx); continue; }
        const v = closePos(p, c, reason, p.s.close[i], sr);
        costF += (v * sr) / prevV; sellN += v;
      }
    }
    const en = pendEnt.get(c);
    if (en) {
      pendEnt.delete(c);
      let V = cash;
      for (const p of pos.values()) V += posValue(p);
      for (const { list, free } of en) {
        reserved -= free;
        let filled = 0;
        for (const cd of list) {
          if (filled >= free) break;
          if (pos.has(cd.code)) continue;
          const i = cd.s.idx.get(d);
          if (i === undefined) continue;
          if (cd.s.vol[i] === 0) { out.haltSkip++; continue; }
          const amt = Math.min(cfg.capFrac * V, cash);
          if (!(amt > 0)) continue;
          const adj = cd.s.close[i], rawPx = cd.s.raw[i];
          let shares: number, spend: number, lastPx: number;
          if (int) { shares = Math.floor(amt / (rawPx * buyMult)); if (shares < 1) continue; spend = shares * rawPx * buyMult; lastPx = rawPx; }
          else { spend = amt; shares = amt / (adj * buyMult); lastPx = adj; }
          cash -= spend; buyN += spend; costF += (spend - shares * lastPx) / prevV;
          const evs = evOf(cd.code);
          let ev = 0;
          while (ev < evs.length && evs[ev].eventDate <= d) ev++;
          const rep = !!o.replace?.has(`${cd.code}|${c}`);
          pos.set(cd.code, { code: cd.code, s: cd.s, shares, lastPx, entryC: c, entryAdj: adj, entryRaw: rawPx, peak: adj, spend, vAtEntry: V, ev, rep, repVal: shares * lastPx, exitSched: false });
          out.entryCs.push(c);
          filled++;
        }
      }
    }
    let V = cash;
    for (const p of pos.values()) V += posValue(p);
    if (c > cS) {
      out.dates.push(d); out.ret.push((V / prevV - 1) * 100); out.costFrac.push(costF); out.nPos.push(pos.size);
      out.inv.push(V > 0 ? (V - cash) / V : 0);
      if (o.onDay) o.onDay(c, V, [...pos.values()].map((p) => [p.code, posValue(p)] as [string, number]));
      if (buyN + sellN > 1e-12) out.turn.push({ d, v: prevV > 0 ? (buyN + sellN) / 2 / prevV : 0 });
      if (o.detail) {
        let mx = 0;
        for (const p of pos.values()) { const v = posValue(p); if (v > mx) mx = v; }
        out.wMax.push(pos.size && V > 0 ? mx / V : NaN);
      }
    }
    if (c + o.lag < nCal) {
      for (const p of pos.values()) {
        if (p.exitSched) continue;
        const i = p.s.idx.get(d);
        if (i !== undefined) p.peak = Math.max(p.peak, p.s.close[i]);
        const reason = hooks.exitReason(p, c, i);
        if (reason) {
          p.exitSched = true;
          const m = pendExit.get(c + o.lag) ?? new Map<string, string>();
          m.set(p.code, reason);
          pendExit.set(c + o.lag, m);
        }
      }
      const free = cfg.maxPos - pos.size - reserved;
      if (free > 0) {
        const list = hooks.candsOf(c, (code) => pos.has(code), (code) => cfg.cooldown > 0 && lastExit.get(code) !== undefined && c - (lastExit.get(code) as number) < cfg.cooldown).filter((x) => !pos.has(x.code) && (cfg.cooldown <= 0 || lastExit.get(x.code) === undefined || c - (lastExit.get(x.code) as number) >= cfg.cooldown));
        if (list.length) {
          const arr = pendEnt.get(c + o.lag) ?? [];
          arr.push({ list, free });
          pendEnt.set(c + o.lag, arr);
          reserved += free;
        }
      }
    }
    prevV = V;
  }
  return out;
}
