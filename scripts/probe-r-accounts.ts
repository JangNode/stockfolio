/**
 * [임시 연구 — 병합 금지] 연구 R 단계 1 원인 확인(읽기 전용): DART 주요계정 API의 account_nm이 어떻게 내려오는지(특히 당기순이익) 소수 호출로 확인한다.
 * 사전 등록: docs/research/r-allcap-fundamentals-prereg.md (8c88160). 연구용 키(DART_API_KEY_2/_3)만, 호출 20건 이내, 키 값은 출력하지 않는다. 쓰기 없음.
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const BASE = "https://opendart.fss.or.kr/api";
const MAX_CALLS = 20;
// 대형·중형·코스닥·적자 가능 종목을 섞은 소수 표본(종목코드 → DB의 corp_code로 변환)
const STOCKS = ["005930", "000660", "035720", "068270", "247540", "086520", "263750", "293490", "041510", "036570", "096770", "009830"];
const keys = [process.env.DART_API_KEY_2, process.env.DART_API_KEY_3].filter((k): k is string => !!k);
let calls = 0;

async function get(path: string, params: string): Promise<{ status: string; message: string; list: Record<string, string>[] }> {
  if (calls >= MAX_CALLS) throw new Error(`호출 상한 ${MAX_CALLS}건`);
  calls++;
  const res = await fetch(`${BASE}/${path}?crtfc_key=${keys[0]}&${params}`, { signal: AbortSignal.timeout(120_000) });
  const j = (await res.json()) as { status?: string; message?: string; list?: Record<string, string>[] };
  return { status: String(j.status ?? "?"), message: String(j.message ?? ""), list: j.list ?? [] };
}

async function main(): Promise<void> {
  if (!keys.length) throw new Error("DART_API_KEY_2/_3가 필요합니다.");
  const { data, error } = await supabaseAdmin.from("dart_corp_codes").select("corp_code, stock_code, corp_name").in("stock_code", STOCKS);
  if (error) throw new Error(error.message);
  const corps = (data ?? []).map((r) => ({ corp: String(r.corp_code), stock: String(r.stock_code), name: String(r.corp_name) }));
  console.log(`표본 회사 ${corps.length}개: ${corps.map((c) => `${c.stock} ${c.name}`).join(", ")}`);
  const multi = corps.map((c) => c.corp).join(",");

  const freq = new Map<string, number>(), freqNi = new Map<string, number>();
  const perCall: string[] = [];
  const tally = (list: Record<string, string>[]): void => {
    for (const r of list) {
      const k = `${r.sj_div}|${r.account_nm}`;
      freq.set(k, (freq.get(k) ?? 0) + 1);
      if (/순이익|순손실|당기/.test(r.account_nm ?? "")) freqNi.set(k, (freqNi.get(k) ?? 0) + 1);
    }
  };
  const plan: [string, string, string][] = [
    ["fnlttMultiAcnt.json", "2023", "11013"], ["fnlttMultiAcnt.json", "2023", "11012"], ["fnlttMultiAcnt.json", "2023", "11014"], ["fnlttMultiAcnt.json", "2023", "11011"],
    ["fnlttMultiAcnt.json", "2017", "11011"], ["fnlttMultiAcnt.json", "2019", "11012"], ["fnlttMultiAcnt.json", "2025", "11011"],
  ];
  for (const [path, y, rc] of plan) {
    const r = await get(path, `corp_code=${multi}&bsns_year=${y}&reprt_code=${rc}`);
    tally(r.list);
    perCall.push(`다중 ${y}/${rc}: status ${r.status} 행 ${r.list.length} 회사 ${new Set(r.list.map((x) => x.corp_code)).size}개`);
  }
  const singles: [string, string, string][] = [[corps[0].corp, "2023", "11011"], [corps[2].corp, "2023", "11012"], [corps[6]?.corp ?? corps[1].corp, "2024", "11011"]];
  for (const [corp, y, rc] of singles) {
    const r = await get("fnlttSinglAcnt.json", `corp_code=${corp}&bsns_year=${y}&reprt_code=${rc}`);
    tally(r.list);
    perCall.push(`단일 ${corp} ${y}/${rc}: status ${r.status} 행 ${r.list.length}`);
  }
  console.log(`\n호출 ${calls}건(상한 ${MAX_CALLS}):\n${perCall.join("\n")}`);
  const fmt = (m: Map<string, number>): string => [...m].sort((a, b) => b[1] - a[1]).map(([k, v]) => `| ${k.replace("|", " | ")} | ${v} |`).join("\n");
  console.log(`\n=== account_nm 종류별 건수(전 응답 합, sj_div | account_nm) ===\n| sj_div | account_nm | 건수 |\n|---|---|---|\n${fmt(freq)}`);
  console.log(`\n=== 순이익·순손실·'당기' 포함 계정명 ===\n| sj_div | account_nm | 건수 |\n|---|---|---|\n${fmt(freqNi)}`);
  const exact = [...freq].filter(([k]) => k.split("|")[1].replace(/\s+/g, "") === "당기순이익").reduce((a, [, v]) => a + v, 0);
  console.log(`\n수집기 현재 매칭 규칙(공백 제거 후 '당기순이익'과 정확히 같음)에 걸리는 행: ${exact}건`);
}

main().catch((e) => { console.error(String((e as Error).message ?? e).replace(/crtfc_key=[^&\s"]*/g, "***")); process.exit(1); });
