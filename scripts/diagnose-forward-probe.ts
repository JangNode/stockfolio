/**
 * [임시 진단 — 병합 금지, 시험 아님(시험 번호 293 유지)] 앞으로 쌓이는 데이터 수집 계획(docs/research/forward-data-plan.md 7절)의 가정 검증용 소량 KIS 호출.
 * FWD_PROBE=main: 일봉 소진율(D·M) 각 1회, 분봉 하루 4회(2026-10-23, 호출 속도·행 수·용량·일 거래량 대조), 분봉 깊이 경계 7회(13~21개월 전 + 백필 시작일), 현재가 5종목(보유율 환산 대조).
 * FWD_PROBE=final: 일봉 소진율 삼성전자 1회(마지막 행 확정 시각 점검: 실행 시각(KST)과 마지막 2행 값만 출력).
 * 저장 없음(Supabase·Storage 쓰기 0, 응답은 요약만), 공시(DART) 사용 없음, 키 값 출력 없음. 호출 금지 시간대(14:00~15:40, 03:50~06:20 KST)에는 실행을 거부한다.
 */
import { parquetWriteBuffer } from "hyparquet-writer";
import { callKis, newKisRun, blockedNow, kst, kstDate, num, rowsOf, sleep, type Rec } from "@/lib/forwardCollectKit";
import { FWD_DAILY_PATH, FWD_DAILY_TR, FWD_PRICE_PATH, FWD_PRICE_TR, FWD_MIN_PATH, FWD_MIN_TR, FWD_MIN_END_HHMMSS, FWD_MIN_PAGE_ROWS } from "@/lib/forwardDataConfig";

const T0 = Date.now();
const MODE = (process.env.FWD_PROBE ?? "").trim().toLowerCase();
if (!["main", "final"].includes(MODE)) throw new Error("FWD_PROBE=main|final 필요");
const STOCK = "005930";
const MAX = 3600e3;
const run = newKisRun();
const keysOf = (r: Rec | undefined): string => (r ? Object.keys(r).join(",") : "-");
const med = (a: number[]): number => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : Number.NaN; };

async function daily(label: string, period: "D" | "M", code = STOCK): Promise<Rec[]> {
  const body = await callKis(run, T0, MAX, label, FWD_DAILY_PATH, FWD_DAILY_TR, { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: code, FID_PERIOD_DIV_CODE: period, FID_ORG_ADJ_PRC: "0" });
  if (body === null) throw new Error(`${label} 호출 실패: ${run.stop ?? "오류"}`);
  return rowsOf(body, ["output", "output2", "output1"]);
}
const hhmmssSub1m = (t: string): string => { const m = Number(t.slice(0, 2)) * 60 + Number(t.slice(2, 4)) - 1; return `${String(Math.floor(m / 60)).padStart(2, "0")}${String(m % 60).padStart(2, "0")}00`; };
async function minuteCall(date8: string, hhmmss: string): Promise<Rec[] | null> {
  const body = await callKis(run, T0, MAX, `분봉 ${date8} ${hhmmss}`, FWD_MIN_PATH, FWD_MIN_TR, { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: STOCK, FID_INPUT_HOUR_1: hhmmss, FID_INPUT_DATE_1: date8, FID_PW_DATA_INCU_YN: "Y", FID_FAKE_TICK_INCU_YN: "" });
  return body === null ? null : rowsOf(body, ["output2", "output", "output1"]);
}

async function main(): Promise<void> {
  console.log(`가정 검증 프로브(${MODE}) 시작: ${new Date().toISOString()} (KST ${kst()}) | 저장 없음, DART 0, 키 비출력`);
  if (blockedNow()) throw new Error("호출 금지 시간대(14:00~15:40, 03:50~06:20 KST)라 실행하지 않는다");
  if (MODE === "final") {
    const rows = await daily("소진율 마지막 행 확정 시각 점검", "D");
    const top = rows.slice(0, 3).map((r) => `${r.stck_bsop_date} 소진율 ${r.hts_frgn_ehrt} 순매수 ${r.frgn_ntby_qty} 거래량 ${r.acml_vol} 종가 ${r.stck_clpr}`);
    console.log(`[확정 시각] 실행 KST ${kstDate()} ${kst()} | 응답 ${rows.length}행, 최신 행부터: ${top.join(" | ")}`);
    console.log(`호출 ${run.req}회, 지연 ${run.latenciesMs.join(",")}ms | Storage 쓰기 0 | DB 쓰기 0 | DART 0`);
    return;
  }

  // ---- 1. 일봉 D·M ----
  const d = await daily("일봉(D)", "D");
  const dds = d.map((r) => String(r.stck_bsop_date)).sort();
  console.log(`\n=== 1. 일봉 inquire-daily-price (삼성전자) ===\n[D] ${d.length}행, 날짜 ${dds[0]}~${dds[dds.length - 1]}, 필드: ${keysOf(d[0])}`);
  console.log(`  최근 3행: ${d.slice(0, 3).map((r) => `${r.stck_bsop_date} 소진율 ${r.hts_frgn_ehrt} 순매수 ${r.frgn_ntby_qty} 거래량 ${r.acml_vol}`).join(" | ")}`);
  console.log(`  소진율 숫자 ${d.filter((r) => num(r.hts_frgn_ehrt) !== null).length}/${d.length}행, 범위 ${Math.min(...d.map((r) => num(r.hts_frgn_ehrt) ?? 1e9))}~${Math.max(...d.map((r) => num(r.hts_frgn_ehrt) ?? -1e9))}`);
  const m = await daily("일봉(M)", "M");
  const mds = m.map((r) => String(r.stck_bsop_date)).sort();
  console.log(`[M] ${m.length}행, 날짜 ${mds[0]}~${mds[mds.length - 1]}, 최근 2행: ${m.slice(0, 2).map((r) => `${r.stck_bsop_date} 소진율 ${r.hts_frgn_ehrt}`).join(" | ")}`);
  const dayVol = new Map(d.map((r) => [String(r.stck_bsop_date), num(r.acml_vol)]));

  // ---- 2. 분봉 하루 4회 (속도·행 수·용량·일 거래량 대조) ----
  const DAY = "20261023";
  console.log(`\n=== 2. 분봉 inquire-time-dailychartprice (삼성전자 ${DAY}) ===`);
  const all: Rec[] = [];
  let end = FWD_MIN_END_HHMMSS, calls = 0;
  const c0 = Date.now();
  for (; calls < 6; calls++) {
    const rows = await minuteCall(DAY, end);
    if (rows === null) throw new Error(`분봉 호출 실패: ${run.stop ?? "오류"}`);
    const ts = rows.map((r) => String(r.stck_cntg_hour)).sort();
    console.log(`  호출 ${calls + 1}: 종료 ${end} → ${rows.length}행, 시각 ${ts[0] ?? "-"}~${ts[ts.length - 1] ?? "-"}${calls === 0 ? `, 필드: ${keysOf(rows[0])}` : ""} | 지연 ${run.latenciesMs[run.latenciesMs.length - 1]}ms`);
    all.push(...rows.filter((r) => String(r.stck_bsop_date) === DAY));
    if (rows.length < FWD_MIN_PAGE_ROWS || !ts.length || Number(ts[0].slice(0, 4)) <= 900) { calls++; break; }
    end = hhmmssSub1m(ts[0]);
  }
  const uniq = new Map<string, Rec>();
  for (const r of all) uniq.set(String(r.stck_cntg_hour), r);
  const ts = [...uniq.keys()].sort();
  const sumVol = [...uniq.values()].reduce((a, r) => a + (num(r.cntg_vol) ?? 0), 0);
  const lastCum = uniq.get(ts[ts.length - 1]);
  console.log(`  합계 ${calls}회, 응답 ${all.length}행, 고유 시각 ${uniq.size}개(${ts[0]}~${ts[ts.length - 1]}), 중복 ${all.length - uniq.size} | 경과 ${((Date.now() - c0) / 1000).toFixed(1)}초(호출당 평균 ${((Date.now() - c0) / calls / 1000).toFixed(2)}초)`);
  console.log(`  분봉 체결량 합 ${sumVol} vs 일봉 거래량 ${dayVol.get(DAY) ?? "-"} (비율 ${dayVol.get(DAY) ? (sumVol / (dayVol.get(DAY) as number)).toFixed(4) : "-"}), 마지막 분 누적대금 ${lastCum?.acml_tr_pbmn ?? "-"}`);
  const rowsDay = [...uniq.values()].sort((a, b) => (String(a.stck_cntg_hour) < String(b.stck_cntg_hour) ? -1 : 1));
  if (rowsDay.length) {
    const buf = parquetWriteBuffer({ columnData: [
      { name: "trade_date", data: rowsDay.map(() => 20261023), type: "INT32" as const },
      { name: "hhmm", data: rowsDay.map((r) => Number(String(r.stck_cntg_hour).slice(0, 4))), type: "INT32" as const },
      { name: "open", data: rowsDay.map((r) => num(r.stck_oprc) ?? 0), type: "INT32" as const },
      { name: "high", data: rowsDay.map((r) => num(r.stck_hgpr) ?? 0), type: "INT32" as const },
      { name: "low", data: rowsDay.map((r) => num(r.stck_lwpr) ?? 0), type: "INT32" as const },
      { name: "close", data: rowsDay.map((r) => num(r.stck_prpr) ?? 0), type: "INT32" as const },
      { name: "volume", data: rowsDay.map((r) => num(r.cntg_vol) ?? 0), type: "INT32" as const },
      { name: "amount", data: rowsDay.map((r) => num(r.acml_tr_pbmn) ?? 0), type: "DOUBLE" as const },
    ] });
    console.log(`  하루 Parquet(INT32×6 + DOUBLE 1): ${rowsDay.length}행 ${buf.byteLength} B → 행당 ${(buf.byteLength / rowsDay.length).toFixed(1)} B (하루 파일 기준, 월 파일은 반복 구조가 많아 더 작을 수 있음 — 실제 값은 첫 월 파일에서 확정)`);
  }

  // ---- 3. 분봉 깊이 경계 ----
  console.log(`\n=== 3. 분봉 깊이 경계 (삼성전자, 종료 ${FWD_MIN_END_HHMMSS}, 호출당 ${FWD_MIN_PAGE_ROWS}행 상한) ===`);
  const depth: [string, string][] = [["20251117", "백필 시작일(12개월)"], ["20251016", "13개월 전"], ["20250916", "14개월 전"], ["20250818", "15개월 전"], ["20250616", "17개월 전"], ["20250416", "19개월 전"], ["20250217", "21개월 전"]];
  for (const [dt, lb] of depth) {
    const rows = await minuteCall(dt, FWD_MIN_END_HHMMSS);
    if (rows === null) throw new Error(`깊이 호출 실패: ${run.stop ?? "오류"}`);
    const t2 = rows.filter((r) => String(r.stck_bsop_date) === dt).map((r) => String(r.stck_cntg_hour)).sort();
    console.log(`  ${dt} (${lb}): 응답 ${rows.length}행, 해당 날짜 ${t2.length}행${t2.length ? `, ${t2[0]}~${t2[t2.length - 1]}` : ""} | 지연 ${run.latenciesMs[run.latenciesMs.length - 1]}ms`);
  }

  // ---- 4. 현재가 5종목 (보유율 환산 대조) ----
  console.log(`\n=== 4. 현재가 inquire-price: 보유율 = frgn_hldn_qty ÷ lstn_stcn × 100 대 소진율 hts_frgn_ehrt ===`);
  for (const code of ["005930", "000660", "015760", "003490", "105560"]) {
    const body = await callKis(run, T0, MAX, `현재가 ${code}`, FWD_PRICE_PATH, FWD_PRICE_TR, { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: code });
    if (body === null) throw new Error(`현재가 호출 실패: ${run.stop ?? "오류"}`);
    const o = ((body.output as Rec | undefined) ?? {}) as Rec;
    const hold = num(o.frgn_hldn_qty), lstn = num(o.lstn_stcn), ehrt = num(o.hts_frgn_ehrt);
    const rate = hold !== null && lstn ? (hold / lstn) * 100 : Number.NaN;
    console.log(`  ${code}: 보유수량 ${hold} 상장주식수 ${lstn} 소진율 ${ehrt} → 보유율 ${Number.isFinite(rate) ? rate.toFixed(3) : "-"}%, 소진율 ÷ 보유율 ${Number.isFinite(rate) && ehrt !== null ? (ehrt / rate).toFixed(3) : "-"} (한도 비율의 역수 가정: 100% → 1.000)${code === STOCK ? ` | 일봉 마지막 행 소진율 ${d[0]?.hts_frgn_ehrt}` : ""}`);
    await sleep(0);
  }
  const lat = run.latenciesMs;
  console.log(`\n호출 ${run.req}회(재시도 포함), 지연 중앙값 ${med(lat)}ms 최소 ${Math.min(...lat)}ms 최대 ${Math.max(...lat)}ms, 순차 평균 ${((Date.now() - T0) / run.req / 1000).toFixed(2)}초/호출, rate limit ${run.rlEvents}회 | Storage 쓰기 0 | DB 쓰기 0 | DART 0 | 소요 ${((Date.now() - T0) / 1000).toFixed(0)}초`);
}
main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });
