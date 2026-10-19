/**
 * [임시 점검 — 병합 금지, 읽기 전용, 저장 없음] KRX etp/etf_bydd_trd로 시점별 업종 ETF 유니버스 점검.
 * KRX 요청 총 30건 이하(AUTH_KEY = 기존 KRX_API_KEY, 키 값 출력 금지). DART·KIS 0건. DB 접근 없음. 숫자와 표만 출력한다.
 */
import {
  KRX_SECTOR_ETF_REQUEST_CAP, KRX_SECTOR_ETF_GAP_MS, KRX_SECTOR_ETF_DATES, KRX_SECTOR_ETF_LAST_DATE, KRX_SECTOR_ETF_COUNT_DATES, KRX_SECTOR_KEYWORDS,
  KRX_SECTOR_EXCLUDE, KRX_SECTOR_FOREIGN_RE, KRX_SECTOR_DOMESTIC_RE,
} from "@/lib/krxSectorEtfConfig";

const T0 = Date.now();
const BASE = "https://data-dbg.krx.co.kr/svc/apis";
let requests = 0;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
type Row = Record<string, string>;
interface Resp { http: number | string; code: string; msg: string; rows: Row[] }

async function krx(basDd: string, key: string): Promise<Resp> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (requests >= KRX_SECTOR_ETF_REQUEST_CAP) return { http: "-", code: "-", msg: "요청 상한", rows: [] };
    requests++;
    await sleep(KRX_SECTOR_ETF_GAP_MS);
    try {
      const res = await fetch(`${BASE}/etp/etf_bydd_trd?basDd=${basDd}`, { headers: { AUTH_KEY: key } });
      const text = await res.text();
      let j: Record<string, unknown> | null = null;
      try { j = JSON.parse(text) as Record<string, unknown>; } catch { j = null; }
      const out: Resp = { http: res.status, code: String(j?.respCode ?? "-"), msg: String(j?.respMsg ?? "-"), rows: (j?.OutBlock_1 as Row[] | undefined) ?? [] };
      if (res.status >= 500 && attempt === 0) continue;
      return out;
    } catch (e) {
      if (attempt === 0) continue;
      return { http: "fetch 실패", code: "-", msg: e instanceof Error ? e.message : String(e), rows: [] };
    }
  }
  return { http: "-", code: "-", msg: "-", rows: [] };
}

const dfmt = (d: string): string => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
const won = (s: string | undefined): string => { const n = Number(String(s ?? "").replace(/,/g, "")); return Number.isFinite(n) && n > 0 ? `${(n / 1e8).toFixed(1)}억` : "-"; };

interface Seen { code: string; names: Map<string, string>; idxNames: Map<string, string>; dates: string[] }

async function main(): Promise<void> {
  const key = process.env.KRX_API_KEY;
  if (!key) throw new Error("KRX_API_KEY 환경변수가 필요합니다.");
  console.log(`KRX 업종 ETF 유니버스 점검 시작(읽기 전용): ${new Date().toISOString()} | 요청 상한 ${KRX_SECTOR_ETF_REQUEST_CAP}`);

  console.log("\n=== 1. 날짜별 ETF 수 ===\n| 날짜 | HTTP | 전체 ETF 수 | IDX_IND_NM 있는 행 |\n|---|---|---|---|");
  const byDate = new Map<string, Row[]>();
  for (const d of KRX_SECTOR_ETF_DATES) {
    const r = await krx(d, key);
    byDate.set(d, r.rows);
    console.log(`| ${dfmt(d)} | ${r.http}${r.code !== "-" ? `/${r.code}` : ""} | ${r.rows.length} | ${r.rows.filter((x) => (x.IDX_IND_NM ?? "").trim()).length} |`);
  }
  const first = [...byDate.values()].find((r) => r.length);
  if (first) console.log(`필드명: ${Object.keys(first[0]).join(", ")}`);

  // 코드별 이력
  const seen = new Map<string, Seen>();
  for (const d of KRX_SECTOR_ETF_DATES) for (const r of byDate.get(d) ?? []) {
    const code = r.ISU_CD ?? r.ISU_SRT_CD ?? "";
    if (!code) continue;
    if (!seen.has(code)) seen.set(code, { code, names: new Map(), idxNames: new Map(), dates: [] });
    const s = seen.get(code)!;
    s.names.set(d, r.ISU_NM ?? ""); s.idxNames.set(d, r.IDX_IND_NM ?? ""); s.dates.push(d);
  }
  const lastRows = new Map((byDate.get(KRX_SECTOR_ETF_LAST_DATE) ?? []).map((r) => [r.ISU_CD ?? r.ISU_SRT_CD ?? "", r]));

  // 분류
  interface Cls { code: string; name: string; idxNm: string; sector: string; reason: string; first: string; inLast: boolean; aum: string; tv: string; last: string }
  const classified: Cls[] = [];
  for (const s of seen.values()) {
    const last = s.dates[s.dates.length - 1];
    const name = s.names.get(last) ?? "", idxNm = s.idxNames.get(last) ?? "";
    const text = `${name} ${idxNm}`;
    const allText = [...s.names.values(), ...s.idxNames.values()].join(" ");
    const hit = KRX_SECTOR_KEYWORDS.find((k) => k.re.test(text)) ?? KRX_SECTOR_KEYWORDS.find((k) => k.re.test(allText));
    if (!hit) continue;
    let reason = KRX_SECTOR_EXCLUDE.find((e) => e.re.test(allText))?.reason ?? "";
    if (!reason && KRX_SECTOR_FOREIGN_RE.test(allText) && !KRX_SECTOR_DOMESTIC_RE.test(allText)) reason = "해외 지수";
    const lr = lastRows.get(s.code);
    classified.push({ code: s.code, name, idxNm, sector: hit.sector, reason, first: s.dates[0], inLast: !!lr, aum: lr ? won(lr.INVSTASST_NETASST_TOTAMT) : "-", tv: lr ? won(lr.ACC_TRDVAL) : "-", last });
  }
  classified.sort((a, b) => a.sector.localeCompare(b.sector, "ko") || a.first.localeCompare(b.first) || a.code.localeCompare(b.code));
  const kept = classified.filter((c) => !c.reason);

  console.log(`\n=== 2. 업종 키워드에 걸린 ETF ${classified.length}개 (제외 사유 있는 것 ${classified.length - kept.length}개) ===`);
  console.log("| 업종 | 코드 | 종목명 | 기초지수명 | 처음 등장(조회일 중) | 마지막 등장 | 2026-10-16 존재 | 순자산총액 | 거래대금 | 제외 사유 |\n|---|---|---|---|---|---|---|---|---|---|");
  for (const c of classified) console.log(`| ${c.sector} | ${c.code} | ${c.name} | ${c.idxNm} | ${dfmt(c.first)} | ${dfmt(c.last)} | ${c.inLast ? "O" : "X"} | ${c.aum} | ${c.tv} | ${c.reason || "-"} |`);

  console.log("\n=== 3. 업종별 ETF (제외 사유 없는 것) — 처음 등장 날짜가 가장 이른 것에 ★ (동률은 모두 ★) ===");
  const sectors = [...new Set(kept.map((c) => c.sector))];
  const repFirst = new Map<string, string>();
  console.log("| 업종 | ETF 수 | 처음 등장 날짜 | ★대표(코드 종목명) | 나머지(코드 종목명 처음 등장) |\n|---|---|---|---|---|");
  for (const sct of sectors) {
    const list = kept.filter((c) => c.sector === sct);
    const earliest = list.map((c) => c.first).sort()[0];
    repFirst.set(sct, earliest);
    const reps = list.filter((c) => c.first === earliest);
    const rest = list.filter((c) => c.first !== earliest);
    console.log(`| ${sct} | ${list.length} | ${dfmt(earliest)} | ${reps.map((c) => `${c.code} ${c.name}`).join("; ")} | ${rest.map((c) => `${c.code} ${c.name} ${dfmt(c.first)}`).join("; ") || "-"} |`);
  }

  console.log("\n=== 4. 시점별 존재하는 업종 수 (업종별 대표 ETF 기준 = 그 업종 첫 등장 ≤ 시점) ===\n| 시점 | 업종 수 |\n|---|---|");
  for (const d of KRX_SECTOR_ETF_DATES) console.log(`| ${dfmt(d)}${(KRX_SECTOR_ETF_COUNT_DATES as readonly string[]).includes(d) ? "" : " (참고)"} | ${sectors.filter((sct) => repFirst.get(sct)! <= d).length} |`);
  console.log("시점별 업종 목록:");
  for (const d of KRX_SECTOR_ETF_COUNT_DATES) console.log(`  ${dfmt(d)}: ${sectors.filter((sct) => repFirst.get(sct)! <= d).join(", ") || "-"}`);

  console.log("\n=== 5. 2026-10-16에 없는 업종 ETF (제외 사유 없는 것 중 코드가 마지막 날짜 응답에 없음) ===");
  const gone = kept.filter((c) => !c.inLast);
  if (!gone.length) console.log("없음");
  else { console.log("| 업종 | 코드 | 종목명 | 처음 등장 | 마지막 등장 |\n|---|---|---|---|---|"); for (const c of gone) console.log(`| ${c.sector} | ${c.code} | ${c.name} | ${dfmt(c.first)} | ${dfmt(c.last)} |`); }
  console.log("\n같은 코드에서 이름(ISU_NM)이 바뀐 업종 ETF (조회일 간 비교):");
  const renamed = kept.filter((c) => new Set(seen.get(c.code)!.names.values()).size > 1);
  if (!renamed.length) console.log("없음");
  else { console.log("| 코드 | 업종 | 날짜별 종목명 |\n|---|---|---|"); for (const c of renamed) console.log(`| ${c.code} | ${c.sector} | ${[...seen.get(c.code)!.names.entries()].map(([d, n]) => `${dfmt(d)} ${n}`).join(" → ")} |`); }
  console.log("같은 코드에서 기초지수명(IDX_IND_NM)이 바뀐 업종 ETF:");
  const idxRenamed = kept.filter((c) => new Set(seen.get(c.code)!.idxNames.values()).size > 1);
  if (!idxRenamed.length) console.log("없음");
  else { console.log("| 코드 | 업종 | 날짜별 기초지수명 |\n|---|---|---|"); for (const c of idxRenamed) console.log(`| ${c.code} | ${c.sector} | ${[...seen.get(c.code)!.idxNames.entries()].map(([d, n]) => `${dfmt(d)} ${n}`).join(" → ")} |`); }

  console.log(`\nKRX 요청 ${requests}건 | DART·KIS 0 | DB 접근 0 | 소요 ${((Date.now() - T0) / 1000).toFixed(1)}s`);
}

main().catch((e) => { console.error("실패:", e instanceof Error ? e.message : e, `KRX시도=${requests}`); process.exit(1); });
