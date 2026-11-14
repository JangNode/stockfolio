// 매크로 일별 원본 수집(데이터 가능성 점검 3, docs/research/data-feasibility-3.md 결과 기반) 기준값. 사용자 지정 2026-11-14.
// 신호·수익률 계산 없이 원본 일별 값만 Storage Parquet으로 저장한다. 한국 거래일 정렬 규칙(미국 지수 전일 종가, 환율 고시 시점 등)은 다음 사전등록에서 정한다.
export const MACRO_FROM = "2010-01-01";
/** Storage 저장 경로(버킷은 INVESTOR_FLOW_STOCK_STORE_BUCKET). 긴 형식 한 파일 + 매니페스트. */
export const MACRO_PREFIX = "research/macro_daily";
export const MACRO_PARQUET = `${MACRO_PREFIX}/macro_daily.parquet`;
export const MACRO_MANIFEST = `${MACRO_PREFIX}/manifest.json`;
/** Storage 쓰기 예산(바이트): 원본 일별 7개 시리즈, 수십만 행 이하. 넘으면 경고. */
export const MACRO_WRITE_BUDGET_BYTES = 2 * 1024 * 1024;
export const MACRO_STORAGE_CAP_BYTES = 800 * 1024 * 1024;
export const MACRO_ECOS_PAGE = 10_000;
export const MACRO_GAP_MS = 500;
export type MacroSource = "fred" | "ecos";
export interface MacroSeries {
  id: string; source: MacroSource; code: string; ecosCycle?: string; ecosItem?: string;
  /** 보고·매니페스트용 설명(원본 의미를 바꾸지 않는다). */
  label: string; unit: string;
  /** 점검용(출력만): 데이터 가능성 점검 3에서 본 값. 다르면 경고만 한다. */
  check: { date: string; value: number };
}
export const MACRO_SERIES: MacroSeries[] = [
  { id: "WTI", source: "fred", code: "DCOILWTICO", label: "WTI 현물(EIA, Cushing)", unit: "USD/bbl", check: { date: "2011-01-03", value: 91.59 } },
  { id: "BRENT", source: "fred", code: "DCOILBRENTEU", label: "브렌트 현물(EIA, Europe)", unit: "USD/bbl", check: { date: "2011-01-03", value: 0 } },
  { id: "USDKRW_FRED", source: "fred", code: "DEXKOUS", label: "원/달러(연준 H.10 뉴욕 정오 매입율)", unit: "KRW per USD", check: { date: "2011-01-03", value: 0 } },
  { id: "NASDAQ", source: "fred", code: "NASDAQCOM", label: "나스닥 종합 종가(FRED)", unit: "Index (1971-02-05=100)", check: { date: "2011-01-03", value: 0 } },
  { id: "USDKRW_ECOS", source: "ecos", code: "731Y001", ecosCycle: "D", ecosItem: "0000001", label: "원/미국달러(매매기준율, ECOS 731Y001)", unit: "KRW", check: { date: "2011-01-03", value: 1138.9 } },
  { id: "KTB3Y", source: "ecos", code: "817Y002", ecosCycle: "D", ecosItem: "010200000", label: "국고채(3년) 시장금리(ECOS 817Y002)", unit: "% 연", check: { date: "2011-01-03", value: 3.5 } },
  { id: "KTB10Y", source: "ecos", code: "817Y002", ecosCycle: "D", ecosItem: "010210000", label: "국고채(10년) 시장금리(ECOS 817Y002)", unit: "% 연", check: { date: "2011-01-03", value: 4.57 } },
];
