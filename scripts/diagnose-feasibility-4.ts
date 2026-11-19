/**
 * [임시 진단 — 병합 금지, 시험 아님(시험 번호 305 유지)] 연구 묶음 5 블록 D: 저평가(가치) 지표(PER·PBR·배당수익률)용 KIS 데이터 확인.
 * 목적: ① 재무비율(FHKST66430300) 이력 깊이·BPS/EPS 필드 ② 발표일 필드 유무 ③ 상장폐지 종목 조회 ④ 예탁원 배당일정 API ⑤ 현재가(inquire-price)의 PER·PBR 필드 — 모두 소량 호출로 응답 구조만 요약한다.
 * 호출 상한 20회(실제 계획 14회), 저장 없음(Supabase·Storage 쓰기 0), 공시(DART) 사용 없음, 키 값 출력 없음.
 * 실행 거부: 마지막 행 확정 프로브(2026-11-18 07:00 KST) 이전, KST 14:00~15:40·03:50~06:20.
 */
import { callKis, newKisRun, blockedNow, kst, kstDate, rowsOf, type Rec } from "@/lib/forwardCollectKit";

const T0 = Date.now();
// 20회 상한은 1차(13회) + 후속(fu, 4회 계획)을 합친 값이다. 후속 실행은 남은 7회 안에서만 부른다.
const FU2 = process.env.FEAS4_ONLY?.trim() === "fu2"; // 후속 2차: 1차·후속이 모두 오류(404·호출 전처리 오류)여서 시간대를 바꿔 3회만 재시도(합계 20회)
const FU = process.env.FEAS4_ONLY?.trim() === "fu" || FU2;
// 후속 3차(fu3, 사용자 승인 2026-11-20): 공식 예제와 같은 헤더로 재무비율을 다시 호출. 추가 5회(총 25회). 첫 호출이 실패하면 나머지는 부르지 않는다.
const FU3 = process.env.FEAS4_ONLY?.trim() === "fu3";
const MAX_CALLS = FU3 ? 5 : FU2 ? 3 : FU ? 7 : 20;
const NOT_BEFORE_UTC = Date.parse("2026-11-17T22:05:00Z"); // 2026-11-18 07:05 KST: 마지막 확정 프로브(07:00 KST) 뒤
const run = newKisRun();
const MAXMS = 1800e3;
const keysOf = (r: Rec | undefined): string => (r ? Object.keys(r).join(",") : "-");
const show = (r: Rec | undefined): string => (r ? Object.entries(r).map(([k, v]) => `${k}=${String(v)}`).join(" ") : "-");

async function call(label: string, path: string, tr: string, params: Record<string, string>, extra?: Record<string, string>): Promise<Rec | null> {
  if (run.req >= MAX_CALLS) throw new Error(`호출 상한 ${MAX_CALLS}회 도달`);
  const body = await callKis(run, T0, MAXMS, label, path, tr, params, extra);
  if (body === null) console.log(`  [${label}] 실패: ${run.stop ?? "오류(위 줄 참고)"}`);
  return body;
}
const msgOf = (b: Rec | null): string => (b ? `rt_cd=${String(b.rt_cd ?? "")} msg_cd=${String(b.msg_cd ?? "")} msg1=${String(b.msg1 ?? "").slice(0, 80)}` : "응답 없음");

const FR_PATH = "/uapi/domestic-stock/v1/finance/financial-ratio", FR_TR = "FHKST66430300";
async function fr(label: string, code: string, div: "0" | "1", extra?: Record<string, string>): Promise<Rec[]> {
  const b = await call(label, FR_PATH, FR_TR, { FID_DIV_CLS_CODE: div, fid_cond_mrkt_div_code: "J", fid_input_iscd: code }, extra);
  const rows = rowsOf(b, ["output"]);
  const ym = rows.map((r) => String(r.stac_yymm ?? "")).filter(Boolean).sort();
  console.log(`[${label}] ${msgOf(b)} | ${rows.length}행, 결산월 ${ym[0] ?? "-"}~${ym[ym.length - 1] ?? "-"} | 필드: ${keysOf(rows[0])}`);
  for (const r of rows.slice(0, 3)) console.log(`   ${show(r)}`);
  if (rows.length > 3) console.log(`   … 마지막 행 ${show(rows[rows.length - 1])}`);
  return rows;
}

async function main(): Promise<void> {
  console.log(`저평가 지표 데이터 확인(블록 D) 시작: ${new Date().toISOString()} (KST ${kstDate()} ${kst()}) | 저장 없음, DART 0, 키 비출력, 호출 상한 ${MAX_CALLS}회`);
  if (Date.now() < NOT_BEFORE_UTC) throw new Error("마지막 확정 프로브(11-18 07:00 KST) 전이라 실행하지 않는다");
  if (blockedNow()) throw new Error("호출 금지 시간대(14:00~15:40, 03:50~06:20 KST)라 실행하지 않는다");

  if (FU3) {
    // 공식 예제(koreainvestment/open-trading-api examples_llm/kis_auth.py)가 GET마다 보내는 헤더: Accept, charset, User-Agent(예제 값), tr_cont(첫 호출은 빈 문자열)
    const H = { Accept: "text/plain", charset: "UTF-8", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", tr_cont: "" };
    console.log("\n=== 후속 3차: 재무비율(공식 예제와 같은 헤더) ===");
    const y = await fr("삼성전자 연(공식 헤더)", "005930", "0", H);
    if (y.length === 0) { console.log("\n첫 호출 실패 — 승인 조건에 따라 나머지 호출은 쓰지 않는다. 원인 가설만 보고한다."); console.log(`호출 ${run.req}회(상한 ${MAX_CALLS}) | 오류 ${run.errors} | Storage 쓰기 0 | DB 쓰기 0 | DART 0`); return; }
    const q = await fr("삼성전자 분기(공식 헤더)", "005930", "1", H);
    const y12 = y.find((r) => String(r.stac_yymm).endsWith("12")), q12 = q.find((r) => String(r.stac_yymm) === String(y12?.stac_yymm));
    console.log(`[연 vs 분기 일치] 결산월 ${String(y12?.stac_yymm ?? "-")}: 연 BPS ${String(y12?.bps ?? "-")} / 분기 BPS ${String(q12?.bps ?? "-")} · 연 EPS ${String(y12?.eps ?? "-")} / 분기 EPS ${String(q12?.eps ?? "-")}`);
    console.log(`[결산월 표기·고유 결산월 수] 연 ${new Set(y.map((r) => String(r.stac_yymm))).size}개, 분기 ${new Set(q.map((r) => String(r.stac_yymm))).size}개`);
    await fr("한진해운 연(상장폐지, 공식 헤더)", "117930", "0", H);
    const dvp = async (label: string, f: string, t: string): Promise<number> => {
      const b = await call(label, "/uapi/domestic-stock/v1/ksdinfo/dividend", "HHKDB669102C0", { CTS: "", GB1: "0", F_DT: f, T_DT: t, SHT_CD: "005930", HIGH_GB: "" }, H);
      const rows = rowsOf(b, ["output1", "output"]);
      const rd = rows.map((r) => String(r.record_date ?? "")).filter(Boolean).sort();
      console.log(`[${label}] ${msgOf(b)} | ${rows.length}행, 기준일 ${rd[0] ?? "-"}~${rd[rd.length - 1] ?? "-"} | 연속키 ${String((b as Rec | null)?.ctx_area_nk100 ?? "-").slice(0, 20)}`);
      return rows.length;
    };
    const n = await dvp("배당 삼성전자 2000~2024", "20000101", "20241231");
    if (n === 0 && run.req < MAX_CALLS) await dvp("배당 삼성전자 2015~2024(범위 축소)", "20150101", "20241231");
    console.log(`\n후속 3차 호출 ${run.req}회(상한 ${MAX_CALLS}; 이전 20회와 합쳐 ${20 + run.req}회 ≤ 25), 오류 ${run.errors}, rate limit ${run.rlEvents}회 | Storage 쓰기 0 | DB 쓰기 0 | DART 0`);
    return;
  }
  if (FU) {
    // 후속(1차에서 재무비율 경로가 404였음): 운영 코드(lib/kis.ts)에서 쓰는 대차대조표·손익계산서 경로로 이력 깊이·필드·상장폐지 종목 조회를 확인한다(4회).
    console.log("\n=== 후속: 대차대조표·손익계산서(운영 코드와 같은 경로) 이력 깊이·필드 ===");
    const BS = "/uapi/domestic-stock/v1/finance/balance-sheet", IS = "/uapi/domestic-stock/v1/finance/income-statement";
    const fuCalls = FU2
      ? [["대차대조표 삼성전자 연", BS, "FHKST66430100", "005930", "0"], ["재무비율 삼성전자 연", FR_PATH, FR_TR, "005930", "0"], ["대차대조표 한진해운(상장폐지) 연", BS, "FHKST66430100", "117930", "0"]] as const
      : [["대차대조표 삼성전자 연", BS, "FHKST66430100", "005930", "0"], ["대차대조표 삼성전자 분기", BS, "FHKST66430100", "005930", "1"], ["손익계산서 삼성전자 연", IS, "FHKST66430200", "005930", "0"], ["대차대조표 한진해운(상장폐지) 연", BS, "FHKST66430100", "117930", "0"]] as const;
    for (const [lb, path, tr, code, div] of fuCalls) {
      const b = await call(lb, path, tr, { FID_DIV_CLS_CODE: div, fid_cond_mrkt_div_code: "J", fid_input_iscd: code });
      const rows = rowsOf(b, ["output"]);
      const ym = rows.map((r) => String(r.stac_yymm ?? "")).filter(Boolean).sort();
      console.log(`[${lb}] ${msgOf(b)} | ${rows.length}행, 결산월 ${ym[0] ?? "-"}~${ym[ym.length - 1] ?? "-"} | 필드: ${keysOf(rows[0])}`);
      for (const r of rows.slice(0, 3)) console.log(`   ${show(r)}`);
    }
    console.log(`\n후속 호출 ${run.req}회(상한 ${MAX_CALLS}; 1차 13회${FU2 ? " + 후속 4회" : ""}와 합쳐 ${13 + (FU2 ? 4 : 0) + run.req}회 ≤ 20), 오류 ${run.errors}, rate limit ${run.rlEvents}회 | Storage 쓰기 0 | DB 쓰기 0 | DART 0`);
    return;
  }

  console.log("\n=== 1. 재무비율 이력(FHKST66430300) ===");
  const samsungY = await fr("삼성전자 연", "005930", "0");
  const samsungQ = await fr("삼성전자 분기", "005930", "1");
  await fr("SK하이닉스 연", "000660", "0");
  await fr("KB금융 연(금융업)", "105560", "0");
  // 연 12월 결산 행의 BPS가 분기 12월 행과 같은지(재작성 여부 간접 확인)
  const y12 = samsungY.find((r) => String(r.stac_yymm).endsWith("12")), q12 = samsungQ.find((r) => String(r.stac_yymm) === String(y12?.stac_yymm));
  console.log(`[연 vs 분기 일치] 결산월 ${String(y12?.stac_yymm ?? "-")}: 연 BPS ${String(y12?.bps ?? "-")} / 분기 BPS ${String(q12?.bps ?? "-")} · 연 EPS ${String(y12?.eps ?? "-")} / 분기 EPS ${String(q12?.eps ?? "-")}`);

  console.log("\n=== 2. 상장폐지 종목 조회(한진해운 117930, 웅진에너지 103130, 페이퍼코리아 001020) ===");
  for (const [nm, code] of [["한진해운", "117930"], ["웅진에너지", "103130"], ["페이퍼코리아", "001020"]] as const) {
    const rows = await fr(`${nm} 재무비율 연`, code, "0");
    if (rows.length === 0) console.log(`   → ${nm}: 재무비율 응답 행 없음`);
  }

  console.log("\n=== 3. 상품기본조회(search-stock-info, CTPF1002R): 상장일·상장폐지일 필드 ===");
  for (const [nm, code] of [["삼성전자", "005930"], ["한진해운", "117930"], ["웅진에너지", "103130"]] as const) {
    const b = await call(`상품기본 ${nm}`, "/uapi/domestic-stock/v1/quotations/search-stock-info", "CTPF1002R", { PRDT_TYPE_CD: "300", PDNO: code });
    const o = (b?.output ?? {}) as Rec;
    const pick = Object.fromEntries(Object.entries(o).filter(([k]) => /lstg|abol|stat|dt$|date|stop|mket|kospi|kosdaq|tr_stop/i.test(k)));
    console.log(`[상품기본 ${nm}] ${msgOf(b)} | 필드 수 ${Object.keys(o).length} | 상장·폐지·상태 관련: ${show(pick)}`);
  }

  console.log("\n=== 4. 예탁원 배당일정(ksdinfo/dividend, HHKDB669102C0) ===");
  const dv = await call("배당 삼성전자", "/uapi/domestic-stock/v1/ksdinfo/dividend", "HHKDB669102C0", { CTS: "", GB1: "0", F_DT: "20250101", T_DT: "20261117", SHT_CD: "005930", HIGH_GB: "" });
  const dvRows = rowsOf(dv, ["output1", "output"]);
  console.log(`[배당 삼성전자 2025-01-01~2026-11-17] ${msgOf(dv)} | ${dvRows.length}행 | 필드: ${keysOf(dvRows[0])}`);
  for (const r of dvRows.slice(0, 4)) console.log(`   ${show(r)}`);
  const dvAll = await call("배당 전체(1주)", "/uapi/domestic-stock/v1/ksdinfo/dividend", "HHKDB669102C0", { CTS: "", GB1: "0", F_DT: "20261012", T_DT: "20261016", SHT_CD: "", HIGH_GB: "" });
  const dvAllRows = rowsOf(dvAll, ["output1", "output"]);
  console.log(`[배당 전체 종목 2026-10-12~16, 1호출] ${msgOf(dvAll)} | ${dvAllRows.length}행(페이지 크기·연속조회 키 확인용) | 연속 키 CTS=${String((dvAll as Rec | null)?.ctx_area_nk100 ?? (dvAll as Rec | null)?.tr_cont ?? "-")}`);

  console.log("\n=== 5. 현재가(inquire-price, FHKST01010100): PER·PBR·EPS·BPS 필드(현재 값만 제공 → 과거 시점 값은 못 줌) ===");
  const ip = await call("현재가 삼성전자", "/uapi/domestic-stock/v1/quotations/inquire-price", "FHKST01010100", { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: "005930" });
  const o = (ip?.output ?? {}) as Rec;
  const pick = Object.fromEntries(Object.entries(o).filter(([k]) => /per|pbr|eps|bps|stck_prpr|hts_avls|lstn|dvdn/i.test(k)));
  console.log(`[현재가 삼성전자] ${msgOf(ip)} | 필드 수 ${Object.keys(o).length} | 가치 지표 관련: ${show(pick)}`);

  console.log(`\n호출 ${run.req}회(상한 ${MAX_CALLS}), 오류 ${run.errors}, rate limit ${run.rlEvents}회, 지연 중앙값 ${[...run.latenciesMs].sort((a, b) => a - b)[Math.floor(run.latenciesMs.length / 2)] ?? "-"}ms | Storage 쓰기 0 | DB 쓰기 0 | DART 0 | KST ${kst()}`);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });
