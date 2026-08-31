/** 테마(업종) 구분 상수. KIS 종목마스터 파일(kospi_code.mst.zip/kosdaq_code.mst.zip)의
 * KRX 섹터 지수 소속 여부 boolean 플래그(part2_columns의 'KRX자동차'/'KRX반도체'/...
 * 필드, github.com/koreainvestment/open-trading-api의 stocks_info/kis_kospi_code_mst.py,
 * kis_kosdaq_code_mst.py 참고)를 그대로 테마 구분으로 쓴다. "2차전지"류 세부 테마는
 * 이 마스터 파일에 없어 다루지 않는다.
 *
 * 오프셋 파싱은 lib/stockMaster.ts 참고. */
export const THEME_CODES = [
  "krx_semiconductor",
  "krx_bio",
  "krx_auto",
  "krx_bank",
  "krx_securities",
  "krx_insurance",
  "krx_energy_chemical",
  "krx_steel",
  "krx_shipbuilding",
  "krx_construction",
  "krx_media_telecom",
  "krx_transport",
] as const;

export type ThemeCode = (typeof THEME_CODES)[number];

// 종목마스터 필드명 기준 한글 표시명. '선박' 필드는 흔히 부르는 업종명인 '조선'으로 표시한다.
export const THEME_LABELS: Record<ThemeCode, string> = {
  krx_semiconductor: "반도체",
  krx_bio: "바이오",
  krx_auto: "자동차",
  krx_bank: "은행",
  krx_securities: "증권",
  krx_insurance: "보험",
  krx_energy_chemical: "에너지화학",
  krx_steel: "철강",
  krx_shipbuilding: "조선",
  krx_construction: "건설",
  krx_media_telecom: "미디어통신",
  krx_transport: "운송",
};

export function isThemeCode(value: string): value is ThemeCode {
  return (THEME_CODES as readonly string[]).includes(value);
}

// theme_daily_returns.constituents(구성종목 상세 jsonb)는 이 기간이 지나면 비운다 —
// 집계값(change_rate_pct/constituent_count/up_count/down_count)은 계속 유지되므로
// 순위·복리 누적 계산에는 영향이 없다. DB 용량 절약 목적(RULES.md 3번).
export const THEME_CONSTITUENTS_RETENTION_YEARS = 3;
