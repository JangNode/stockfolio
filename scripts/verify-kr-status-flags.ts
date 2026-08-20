/**
 * 임시 검증 스크립트. KIS 국내 종목마스터(.mst)에 거래정지/정리매매/관리종목 플래그
 * 필드가 정확히 몇 바이트째에 있는지 실제 파일로 확인한다. lib/stockMaster.ts의
 * 상장일자 필드도 KIS 공식 스펙 그대로 계산한 값이 실제로는 1바이트씩 밀려 있었던
 * 전례가 있어(주석 참고), 이번에도 스펙만으로 단정하지 않고 실제 파일에서 후보
 * 구간의 문자 분포를 찍어서 "대부분 0이고 소수만 다른 값인" 희소 플래그 패턴을
 * 찾는 방식으로 확인한다.
 *
 * 확인 후 삭제할 것 (verify-us-quotes.ts와 동일한 성격의 임시 스크립트).
 *
 *   tsx --conditions=react-server scripts/verify-kr-status-flags.ts
 */

import AdmZip from "adm-zip";
import iconv from "iconv-lite";

const MASTER_URLS = {
  KOSPI: "https://new.real.download.dws.co.kr/common/master/kospi_code.mst.zip",
  KOSDAQ: "https://new.real.download.dws.co.kr/common/master/kosdaq_code.mst.zip",
} as const;

// lib/stockMaster.ts에 이미 검증돼 있는 상장일자 위치(앵커) — 여기서부터 거꾸로 후보
// 구간을 스캔한다.
const LAYOUT = {
  KOSPI: { tailLength: 228, listedDateOffset: 106, listedDateWidth: 8 },
  KOSDAQ: { tailLength: 222, listedDateOffset: 101, listedDateWidth: 8 },
} as const;

type Market = keyof typeof MASTER_URLS;

async function downloadLines(market: Market): Promise<string[]> {
  const res = await fetch(MASTER_URLS[market]);
  if (!res.ok) throw new Error(`다운로드 실패 (${res.status}): ${MASTER_URLS[market]}`);
  const zipBuffer = Buffer.from(await res.arrayBuffer());
  const zip = new AdmZip(zipBuffer);
  const [entry] = zip.getEntries();
  if (!entry) throw new Error(`zip이 비어 있습니다: ${MASTER_URLS[market]}`);
  const text = iconv.decode(entry.getData(), market === "KOSPI" ? "euc-kr" : "euc-kr");
  return text.split("\n").filter((l) => l.trim());
}

function parseListedDateAt(tail: string, offset: number, width: number): string | null {
  const raw = tail.slice(offset, offset + width);
  return /^\d{8}$/.test(raw) ? raw : null;
}

function analyzeMarket(market: Market, lines: string[]) {
  const { tailLength, listedDateOffset, listedDateWidth } = LAYOUT[market];
  console.log(`\n===== ${market} (총 ${lines.length}건) =====`);

  // 0) 기준점 검증: 기존 코드의 상장일자 위치가 이 스크립트의 파싱 방식으로도 여전히
  // 유효한 날짜를 뽑아내는지 먼저 확인한다(같은 라인 슬라이싱 방식을 쓰고 있는지 sanity check).
  let validDates = 0;
  for (const line of lines) {
    if (line.length < tailLength) continue;
    const tail = line.slice(-tailLength);
    if (parseListedDateAt(tail, listedDateOffset, listedDateWidth)) validDates++;
  }
  console.log(
    `[기준점] listedDateOffset=${listedDateOffset}에서 유효한 8자리 날짜: ${validDates}/${lines.length}건`
  );

  // 1) 후보 구간 스캔: listedDateOffset보다 앞쪽 40바이트 구간에서 오프셋별 문자 분포를 찍는다.
  const scanStart = Math.max(0, listedDateOffset - 45);
  const scanEnd = listedDateOffset;

  for (let offset = scanStart; offset < scanEnd; offset++) {
    const counts = new Map<string, number>();
    for (const line of lines) {
      if (line.length < tailLength) continue;
      const tail = line.slice(-tailLength);
      const ch = tail[offset] ?? "";
      counts.set(ch, (counts.get(ch) ?? 0) + 1);
    }
    const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
    const total = lines.length;
    const top = sorted[0];
    const isSparse = sorted.length <= 4 && top && top[1] / total > 0.9;
    const summary = sorted
      .slice(0, 5)
      .map(([ch, n]) => `'${ch === " " ? "SP" : ch}'=${n}`)
      .join(", ");
    console.log(`  offset ${offset}${isSparse ? " [희소 플래그 후보]" : ""}: ${summary}`);
  }
}

async function main() {
  for (const market of ["KOSPI", "KOSDAQ"] as Market[]) {
    const lines = await downloadLines(market);
    analyzeMarket(market, lines);
  }
}

main().catch((error) => {
  console.error("검증 실패:", error);
  process.exit(1);
});
