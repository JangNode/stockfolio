// 매매 비용 기준값(RULES.md 2번 — 매직넘버 금지, 이 파일 하나로 감사 가능하게).
// 수수료·슬리피지는 2026-09-29 사용자 지정값(진단용으로 쓴 값을 그대로 승격).
export const FEE_PCT_PER_SIDE = 0.00015; // 매수·매도 각 0.015%(거래대금 기준)
export const SLIPPAGE_PCT_PER_SIDE = Number(process.env.EXP_SLIPPAGE_PCT) || 0.001; // [임시 실험] 환경변수로 덮어쓰기 — // 매수·매도 각 0.1%(불리한 방향)

export interface SecuritiesTaxRateStep {
  effectiveFrom: string; // YYYY-MM-DD, 이 날짜(포함)부터 적용(시행일 기준, 연초가 아닌 경우 있음)
  ratePct: number; // 비율(0.003 = 0.3%)
}

// 매도 시 증권거래세(거래세+농특세 합산). KOSPI/KOSDAQ가 매년 동일한 총세율을
// 유지해 온 것을 웹 검색으로 확인해(2026-09-29) 시장 구분 없이 적용한다. US
// 시장은 이 세금 자체가 없다(getSecuritiesTaxRate가 market !== "KR"이면 0 반환).
// 출처: 한국일보(2019-03-21, 23년만의 인하 예고)/이데일리·이투데이(2019-05-21
// 국무회의 의결, 2019-06-03 결제분부터 시행)/조세일보·이투데이(2021년 개정)/
// 머니투데이(2023-01-03, 2023년 0.20%)/미래에셋증권 고시(2024년 0.18%)/
// KB증권·삼성증권·대신증권 공지(2025년 0.15%, 2026년 0.20%로 환원, 2026-01-02
// 결제분부터 — 2026-01-01이 휴장일이라 최초 거래일 기준으로 대체 적용).
export const SECURITIES_TAX_RATE_SCHEDULE: SecuritiesTaxRateStep[] = [
  { effectiveFrom: "2016-01-01", ratePct: 0.003 },
  { effectiveFrom: "2019-06-03", ratePct: 0.0025 },
  { effectiveFrom: "2021-01-01", ratePct: 0.0023 },
  { effectiveFrom: "2023-01-01", ratePct: 0.002 },
  { effectiveFrom: "2024-01-01", ratePct: 0.0018 },
  { effectiveFrom: "2025-01-01", ratePct: 0.0015 },
  { effectiveFrom: "2026-01-01", ratePct: 0.002 },
];
