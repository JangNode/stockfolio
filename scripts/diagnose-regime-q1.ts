// 진단(읽기 전용, 임시): market_regime_daily에서 2026-01~03 구간 국면·KOSPI 종가 요약과 차트용 series 응답 크기를 확인한다. 쓰기 없음.
import { gzipSync } from "node:zlib";
import { getAllRegimeRows } from "@/lib/marketRegimeStorage";

const CODE: Record<string, string> = { bull: "B", neutral: "N", bear: "R", crisis: "C", undefined: "U" };

async function main(): Promise<void> {
  const rows = await getAllRegimeRows();
  const bySource = new Map<string, number>();
  for (const r of rows) bySource.set(r.source, (bySource.get(r.source) ?? 0) + 1);
  console.log(`행 수=${rows.length} 첫날=${rows[0]?.tradeDate} 마지막=${rows[rows.length - 1]?.tradeDate} source별=${[...bySource].map(([k, v]) => `${k}:${v}`).join(", ")}`);

  const q = rows.filter((r) => r.tradeDate >= "2026-01-01" && r.tradeDate <= "2026-03-31");
  const prev = [...rows].reverse().find((r) => r.tradeDate < "2026-01-01");
  console.log(`\n=== 2026-01~03: ${q.length}거래일 (${q[0]?.tradeDate} ~ ${q[q.length - 1]?.tradeDate}) ===`);
  console.log(`직전 거래일(${prev?.tradeDate}) 종가=${prev?.kospiClose}`);
  const days = new Map<string, number>();
  for (const r of q) days.set(r.regime, (days.get(r.regime) ?? 0) + 1);
  console.log(`국면별 일수: ${[...days].map(([k, v]) => `${k} ${v}일(${((v / q.length) * 100).toFixed(1)}%)`).join(", ")}`);
  if (q.length) {
    const first = q[0], last = q[q.length - 1];
    const hi = q.reduce((a, b) => (b.kospiClose > a.kospiClose ? b : a)), lo = q.reduce((a, b) => (b.kospiClose < a.kospiClose ? b : a));
    console.log(`첫날 ${first.tradeDate} 종가 ${first.kospiClose} → 마지막날 ${last.tradeDate} 종가 ${last.kospiClose} (${((last.kospiClose / first.kospiClose - 1) * 100).toFixed(2)}%)`);
    if (prev) console.log(`2025 마지막 종가 대비 3월 말: ${((last.kospiClose / prev.kospiClose - 1) * 100).toFixed(2)}%`);
    console.log(`구간 최고 ${hi.tradeDate} ${hi.kospiClose} / 최저 ${lo.tradeDate} ${lo.kospiClose}`);
    for (const m of ["01", "02", "03"]) {
      const mm = q.filter((r) => r.tradeDate.slice(5, 7) === m);
      if (mm.length) console.log(`  ${m}월: ${mm.length}거래일, 월초 ${mm[0].kospiClose} → 월말 ${mm[mm.length - 1].kospiClose} (${((mm[mm.length - 1].kospiClose / mm[0].kospiClose - 1) * 100).toFixed(2)}%), 국면 ${[...new Set(mm.map((r) => r.regime))].join("/")}`);
    }
    console.log("국면 연속 구간:");
    let s = 0;
    for (let i = 1; i <= q.length; i++) {
      if (i === q.length || q[i].regime !== q[s].regime) { console.log(`  ${q[s].regime} ${q[s].tradeDate}~${q[i - 1].tradeDate} (${i - s}거래일, 종가 ${q[s].kospiClose}→${q[i - 1].kospiClose})`); s = i; }
    }
    const raws = q.filter((r) => r.rawRegime !== r.regime).length;
    console.log(`원신호≠표시 국면(전환 확인 대기)인 날: ${raws}일`);
  }

  const series = { dates: rows.map((r) => r.tradeDate), closes: rows.map((r) => r.kospiClose), regimes: rows.map((r) => CODE[r.regime] ?? "U").join("") };
  const json = JSON.stringify(series);
  const daily = JSON.stringify(rows.map((r) => ({ date: r.tradeDate, regime: r.regime, close: r.kospiClose })));
  console.log(`\n=== series 응답 크기(${rows.length}행) ===`);
  console.log(`열 배열 방식: ${json.length} B (gzip ${gzipSync(json).length} B)`);
  console.log(`행 객체 방식(참고): ${daily.length} B (gzip ${gzipSync(daily).length} B)`);
  const weekly = rows.filter((_, i) => i % 5 === 4 || i === rows.length - 1);
  console.log(`5거래일 간격 다운샘플(참고): ${JSON.stringify({ dates: weekly.map((r) => r.tradeDate), closes: weekly.map((r) => r.kospiClose), regimes: weekly.map((r) => CODE[r.regime] ?? "U").join("") }).length} B`);
}

main().catch((e) => { console.error("진단 실패:", e instanceof Error ? e.message : e); process.exit(1); });
