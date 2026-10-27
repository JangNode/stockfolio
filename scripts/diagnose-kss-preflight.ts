/**
 * [임시 — 병합 금지, 읽기 전용] KODEX 업종 모멘텀 신호 배치 사전 점검(PR #468): 2026-10-28(수) 10:00~11:00 KST에 전 영업일(2026-10-27) 자료가
 * KRX Open API에 있는지 확인한다. etp/etf_bydd_trd 1회 + sto/stk_bydd_trd 1회(KRX 호출 2건), DB·Storage 쓰기 없음, 키 값 출력 없음.
 * 시각(KST 2026-10-28 10:00~11:00)을 벗어나면 호출 없이 종료한다(결과가 "이 시각에 자료가 있는지"의 직접 근거가 되게 하려고).
 */
const BASE = "https://data-dbg.krx.co.kr/svc/apis";
const TARGET = "20261027";

const kst = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, hourCycle: "h23" }).formatToParts(new Date());
const part = (t: string): string => kst.find((p) => p.type === t)!.value;
const kstDate = `${part("year")}-${part("month")}-${part("day")}`, kstTime = `${part("hour")}:${part("minute")}`;

async function probe(path: string): Promise<{ status: number; rows: Record<string, string>[]; dateHeader: string | null; note: string }> {
  const apiKey = process.env.KRX_API_KEY;
  if (!apiKey) throw new Error("KRX_API_KEY 환경 변수가 없습니다.");
  const res = await fetch(`${BASE}/${path}?basDd=${TARGET}`, { headers: { AUTH_KEY: apiKey } });
  const dateHeader = res.headers.get("date");
  let rows: Record<string, string>[] = [], note = "";
  if (res.ok) {
    const body = (await res.json()) as { OutBlock_1?: Record<string, string>[] };
    rows = body.OutBlock_1 ?? [];
    note = `최상위 키 ${Object.keys(body).join(",") || "없음"}`;
  } else note = `본문 앞 120자: ${(await res.text()).slice(0, 120).replace(/\s+/g, " ")}`;
  return { status: res.status, rows, dateHeader, note };
}

async function main(): Promise<void> {
  console.log(`점검 시작: KST ${kstDate} ${kstTime} (basDd=${TARGET})`);
  if (kstDate !== "2026-10-28" || kstTime < "10:00" || kstTime > "11:00") {
    console.log("KST 2026-10-28 10:00~11:00 밖이라 KRX를 호출하지 않고 종료합니다(점검 무효).");
    process.exitCode = 1;
    return;
  }
  const etf = await probe("etp/etf_bydd_trd");
  const e = etf.rows.find((r) => r.ISU_CD === "069500");
  console.log(`[1] etp/etf_bydd_trd | HTTP ${etf.status} | 응답 date 헤더 ${etf.dateHeader} | 행 ${etf.rows.length} | BAS_DD ${[...new Set(etf.rows.map((r) => r.BAS_DD))].join(",") || "-"} | 069500 ${e ? `있음 종가 ${e.TDD_CLSPRC} 거래량 ${e.ACC_TRDVOL} 종목명 ${e.ISU_NM}` : "없음"} | ${etf.note}`);
  const stk = await probe("sto/stk_bydd_trd");
  const withPx = stk.rows.filter((r) => r.TDD_CLSPRC && r.TDD_CLSPRC !== "-" && Number(r.ACC_TRDVOL) > 0);
  const samsung = stk.rows.find((r) => r.ISU_CD === "005930");
  console.log(`[2] sto/stk_bydd_trd | HTTP ${stk.status} | 응답 date 헤더 ${stk.dateHeader} | 행 ${stk.rows.length} | 종가·거래량 있는 행 ${withPx.length} | 시장 ${JSON.stringify(Object.fromEntries([...new Set(stk.rows.map((r) => r.MKT_NM))].map((m) => [m, stk.rows.filter((r) => r.MKT_NM === m).length])))} | BAS_DD ${[...new Set(stk.rows.map((r) => r.BAS_DD))].join(",") || "-"} | 005930 ${samsung ? `종가 ${samsung.TDD_CLSPRC}` : "없음"} | ${stk.note}`);
  console.log(`판정: 기준 행 수 700 이상(배치 KSS_KRX_KOSPI_MIN_ROWS) ${stk.rows.length >= 700 ? "충족" : "미달"} | 069500 종가 ${e ? "있음" : "없음"} | KRX 호출 2건, DB·Storage 쓰기 0`);
}

main().catch((error) => {
  console.error("사전 점검 오류:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
