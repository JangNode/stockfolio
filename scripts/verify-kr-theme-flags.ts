/**
 * 임시 검증 스크립트. lib/stockMaster.ts의 THEME_FLAG_OFFSETS(KRX 섹터 테마 플래그
 * 오프셋)가 실제 종목마스터 파일에서도 맞는지 확인한다. 이미 검증된 상장일자/
 * 상태플래그 앵커 두 곳이 KIS 공식 스펙 대비 정확히 +1 밀려 있다는 근거로 테마 플래그
 * 오프셋도 스펙+1로 계산했지만, 이 필드들 자체의 실제 'Y'/'N' 값은 아직 실파일로
 * 재확인하지 못했다(SKILLS.md "외부 API·사이트 연동" 절 참고).
 *
 * 확인 방법:
 *  1) 소속이 널리 알려진 종목들로 THEME_FLAG_OFFSETS 위치의 값이 기대와 맞는지 확인.
 *  2) 혹시 안 맞으면 그 필드 주변 오프셋의 문자 분포(희소 Y/N 패턴)를 찍어 실제 위치를
 *     눈으로 찾을 수 있게 돕는다.
 *
 * 확인 후 삭제할 것 (verify-kr-status-flags.ts와 동일한 성격의 임시 스크립트).
 *
 *   tsx --conditions=react-server scripts/verify-kr-theme-flags.ts
 */

import AdmZip from "adm-zip";
import iconv from "iconv-lite";
import { THEME_LABELS, type ThemeCode } from "@/lib/themeConfig";

const MASTER_URLS = {
  KOSPI: "https://new.real.download.dws.co.kr/common/master/kospi_code.mst.zip",
  KOSDAQ: "https://new.real.download.dws.co.kr/common/master/kosdaq_code.mst.zip",
} as const;

type Market = keyof typeof MASTER_URLS;

// lib/stockMaster.ts와 동일한 값(중복이지만 이 스크립트는 확인 후 삭제될 임시
// 스크립트라 별도 export 없이 그대로 복붙했다).
const LAYOUT: Record<Market, { tailLength: number }> = {
  KOSPI: { tailLength: 228 },
  KOSDAQ: { tailLength: 222 },
};

const THEME_FLAG_OFFSETS: Record<Market, Record<ThemeCode, number>> = {
  KOSPI: {
    krx_auto: 26,
    krx_semiconductor: 27,
    krx_bio: 28,
    krx_bank: 29,
    krx_energy_chemical: 31,
    krx_steel: 32,
    krx_media_telecom: 34,
    krx_construction: 35,
    krx_securities: 37,
    krx_shipbuilding: 38,
    krx_insurance: 39,
    krx_transport: 40,
  },
  KOSDAQ: {
    krx_auto: 21,
    krx_semiconductor: 22,
    krx_bio: 23,
    krx_bank: 24,
    krx_energy_chemical: 26,
    krx_steel: 27,
    krx_media_telecom: 29,
    krx_construction: 30,
    krx_securities: 32,
    krx_shipbuilding: 33,
    krx_insurance: 34,
    krx_transport: 35,
  },
};

// 소속이 널리 알려진 종목들. code는 단축코드(6자리).
const KNOWN_STOCKS: { market: Market; code: string; name: string; theme: ThemeCode; expected: boolean }[] = [
  { market: "KOSPI", code: "005930", name: "삼성전자", theme: "krx_semiconductor", expected: true },
  { market: "KOSPI", code: "000660", name: "SK하이닉스", theme: "krx_semiconductor", expected: true },
  { market: "KOSPI", code: "005380", name: "현대차", theme: "krx_auto", expected: true },
  { market: "KOSPI", code: "000270", name: "기아", theme: "krx_auto", expected: true },
  { market: "KOSPI", code: "105560", name: "KB금융", theme: "krx_bank", expected: true },
  { market: "KOSPI", code: "055550", name: "신한지주", theme: "krx_bank", expected: true },
  { market: "KOSPI", code: "006800", name: "미래에셋증권", theme: "krx_securities", expected: true },
  { market: "KOSPI", code: "000810", name: "삼성화재", theme: "krx_insurance", expected: true },
  { market: "KOSPI", code: "032830", name: "삼성생명", theme: "krx_insurance", expected: true },
  { market: "KOSPI", code: "051910", name: "LG화학", theme: "krx_energy_chemical", expected: true },
  { market: "KOSPI", code: "005490", name: "POSCO홀딩스", theme: "krx_steel", expected: true },
  { market: "KOSPI", code: "009540", name: "HD한국조선해양", theme: "krx_shipbuilding", expected: true },
  { market: "KOSPI", code: "000720", name: "현대건설", theme: "krx_construction", expected: true },
  { market: "KOSPI", code: "030200", name: "KT", theme: "krx_media_telecom", expected: true },
  { market: "KOSPI", code: "000120", name: "CJ대한통운", theme: "krx_transport", expected: true },
  { market: "KOSDAQ", code: "042700", name: "한미반도체", theme: "krx_semiconductor", expected: true },
  { market: "KOSDAQ", code: "196170", name: "알테오젠", theme: "krx_bio", expected: true },
];

async function downloadLines(market: Market): Promise<string[]> {
  const res = await fetch(MASTER_URLS[market]);
  if (!res.ok) throw new Error(`다운로드 실패 (${res.status}): ${MASTER_URLS[market]}`);
  const zipBuffer = Buffer.from(await res.arrayBuffer());
  const zip = new AdmZip(zipBuffer);
  const [entry] = zip.getEntries();
  if (!entry) throw new Error(`zip이 비어 있습니다: ${MASTER_URLS[market]}`);
  const text = iconv.decode(entry.getData(), "euc-kr");
  return text.split("\n").filter((l) => l.trim());
}

function findLineByCode(lines: string[], code: string): string | null {
  return lines.find((line) => line.slice(0, 9).trim() === code) ?? null;
}

function printSurroundingOffsets(tail: string, center: number, radius: number): void {
  const parts: string[] = [];
  for (let o = Math.max(0, center - radius); o <= center + radius; o++) {
    const mark = o === center ? "*" : "";
    parts.push(`${o}${mark}='${tail[o]}'`);
  }
  console.log(`      주변: ${parts.join(", ")}`);
}

function analyzeSparsity(lines: string[], market: Market, offset: number): void {
  const { tailLength } = LAYOUT[market];
  const counts = new Map<string, number>();
  for (const line of lines) {
    if (line.length < tailLength) continue;
    const tail = line.slice(-tailLength);
    const ch = tail[offset] ?? "";
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  const summary = sorted.map(([ch, n]) => `'${ch === " " ? "SP" : ch}'=${n}`).join(", ");
  console.log(`      offset ${offset} 전체 분포: ${summary}`);
}

async function main() {
  const linesByMarket: Record<Market, string[]> = {
    KOSPI: await downloadLines("KOSPI"),
    KOSDAQ: await downloadLines("KOSDAQ"),
  };

  console.log("===== 알려진 종목으로 오프셋 확인 =====");
  let passCount = 0;
  let failCount = 0;

  for (const stock of KNOWN_STOCKS) {
    const lines = linesByMarket[stock.market];
    const line = findLineByCode(lines, stock.code);
    if (!line) {
      console.log(`  [찾을 수 없음] ${stock.market} ${stock.code}(${stock.name})`);
      failCount++;
      continue;
    }

    const { tailLength } = LAYOUT[stock.market];
    const tail = line.slice(-tailLength);
    const offset = THEME_FLAG_OFFSETS[stock.market][stock.theme];
    const actual = tail[offset] === "Y";
    const ok = actual === stock.expected;
    if (ok) passCount++;
    else failCount++;

    console.log(
      `  [${ok ? "PASS" : "FAIL"}] ${stock.market} ${stock.code}(${stock.name}) ${THEME_LABELS[stock.theme]}: ` +
        `offset ${offset} = '${tail[offset]}' (기대: ${stock.expected ? "Y" : "N"})`
    );
    if (!ok) {
      printSurroundingOffsets(tail, offset, 5);
    }
  }

  console.log(`\n결과: PASS ${passCount}건, FAIL ${failCount}건`);

  if (failCount > 0) {
    console.log("\n===== FAIL한 테마의 전체 분포(희소 Y/N 패턴 확인용) =====");
    const failedThemes = new Set(
      KNOWN_STOCKS.filter((s) => {
        const line = findLineByCode(linesByMarket[s.market], s.code);
        if (!line) return false;
        const { tailLength } = LAYOUT[s.market];
        const tail = line.slice(-tailLength);
        return (tail[THEME_FLAG_OFFSETS[s.market][s.theme]] === "Y") !== s.expected;
      }).map((s) => `${s.market}:${s.theme}`)
    );
    for (const key of failedThemes) {
      const [market, theme] = key.split(":") as [Market, ThemeCode];
      console.log(`  ${market} ${THEME_LABELS[theme]}`);
      const offset = THEME_FLAG_OFFSETS[market][theme];
      for (let o = offset - 5; o <= offset + 5; o++) {
        analyzeSparsity(linesByMarket[market], market, o);
      }
    }
  }
}

main().catch((error) => {
  console.error("검증 실패:", error);
  process.exit(1);
});
