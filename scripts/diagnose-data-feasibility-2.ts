/**
 * [임시 진단 — 병합 금지, 시험 아님(시험 번호 285 유지), 읽기 전용] 데이터 가용성 점검 2: 아직 연구에 쓰지 않은 KIS·KRX Open API 일별 이상 데이터의 응답 형태와 과거 깊이를 확인한다.
 * 항목마다 시험 호출 1~2회(분봉 깊이만 3회), 종목 1~2개, 날짜 몇 개. 대량 수집·저장 없음(Supabase·Storage 쓰기 0, 응답은 요약만 출력). 공시(DART) 사용 없음. 키 값은 출력하지 않는다.
 * KST 14:00~15:40에는 호출하지 않는다(실행 거부). 호출 사이 간격을 둔다. FEAS_ONLY=id1,id2 로 일부 항목만 다시 호출할 수 있다.
 * 출력 형식: 항목별 요청(경로·TR ID·파라미터), 결과 상태, 응답 배열의 행 수·필드 이름·첫/끝 행(날짜류 필드 위주).
 */
import { kisGetForResearch } from "@/lib/kis";

const KRX_BASE = "https://data-dbg.krx.co.kr/svc/apis";
const SLEEP_MS = 800;
const STOCK = "005930";
const DELISTED = "117930";

interface KisProbe { id: string; item: string; path: string; trId: string; params: Record<string, string>; /** 있으면 응답의 첫 배열 모든 행에서 이 필드들만 한 줄씩 출력한다. */ show?: string[] }
interface KrxProbe { id: string; item: string; endpoint: string; basDd: string }

const Q = "/uapi/domestic-stock/v1/quotations";
const KIS: KisProbe[] = [
  { id: "P1a", item: "프로그램매매 종합현황(일별) 시장 단위, 최근", path: `${Q}/comp-program-trade-daily`, trId: "FHPPG04600001", params: { FID_COND_MRKT_DIV_CODE: "J", FID_MRKT_CLS_CODE: "K", FID_INPUT_DATE_1: "20261001", FID_INPUT_DATE_2: "20261104" } },
  { id: "P1b", item: "프로그램매매 종합현황(일별) 시장 단위, 2011", path: `${Q}/comp-program-trade-daily`, trId: "FHPPG04600001", params: { FID_COND_MRKT_DIV_CODE: "J", FID_MRKT_CLS_CODE: "K", FID_INPUT_DATE_1: "20110103", FID_INPUT_DATE_2: "20110131" } },
  { id: "P2a", item: "종목별 프로그램매매추이(일별), 최근", path: `${Q}/program-trade-by-stock-daily`, trId: "FHPPG04650200", params: { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: STOCK, FID_INPUT_DATE_1: "20261104" } },
  { id: "P2b", item: "종목별 프로그램매매추이(일별), 2015", path: `${Q}/program-trade-by-stock-daily`, trId: "FHPPG04650200", params: { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: STOCK, FID_INPUT_DATE_1: "20150130" } },
  { id: "P3", item: "종목별 프로그램매매추이(체결, 당일)", path: `${Q}/program-trade-by-stock`, trId: "FHPPG04650100", params: { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: STOCK } },
  { id: "P4a", item: "종목별 일별 매수매도 체결량, 최근", path: `${Q}/inquire-daily-trade-volume`, trId: "FHKST03010800", params: { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: STOCK, FID_PERIOD_DIV_CODE: "D", FID_INPUT_DATE_1: "20261001", FID_INPUT_DATE_2: "20261104" } },
  { id: "P4b", item: "종목별 일별 매수매도 체결량, 2011", path: `${Q}/inquire-daily-trade-volume`, trId: "FHKST03010800", params: { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: STOCK, FID_PERIOD_DIV_CODE: "D", FID_INPUT_DATE_1: "20110103", FID_INPUT_DATE_2: "20110131" } },
  { id: "P5", item: "주식현재가 체결(체결강도 tday_rltv, 당일 틱)", path: `${Q}/inquire-ccnl`, trId: "FHKST01010300", params: { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: STOCK } },
  { id: "P6a", item: "주식현재가 시세(투자경고·관리·단기과열·정지 현재 상태 필드, 외국인 소진율)", path: `${Q}/inquire-price`, trId: "FHKST01010100", params: { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: STOCK } },
  { id: "P6b", item: "상품기본조회(관리종목·거래정지 등 현재 상태)", path: `${Q}/search-stock-info`, trId: "CTPF1604R", params: { PRDT_TYPE_CD: "300", PDNO: STOCK } },
  { id: "P7a", item: "VI 발동 현황(날짜 지정), 최근", path: `${Q}/inquire-vi-status`, trId: "FHPST01390000", params: { FID_DIV_CLS_CODE: "0", FID_COND_SCR_DIV_CODE: "20139", FID_MRKT_CLS_CODE: "0", FID_INPUT_ISCD: "", FID_RANK_SORT_CLS_CODE: "0", FID_INPUT_DATE_1: "20261104", FID_TRGT_CLS_CODE: "", FID_TRGT_EXLS_CLS_CODE: "" } },
  { id: "P7b", item: "VI 발동 현황(날짜 지정), 2018", path: `${Q}/inquire-vi-status`, trId: "FHPST01390000", params: { FID_DIV_CLS_CODE: "0", FID_COND_SCR_DIV_CODE: "20139", FID_MRKT_CLS_CODE: "0", FID_INPUT_ISCD: "", FID_RANK_SORT_CLS_CODE: "0", FID_INPUT_DATE_1: "20181101", FID_TRGT_CLS_CODE: "", FID_TRGT_EXLS_CLS_CODE: "" } },
  { id: "P8a", item: "시간외 일자별 주가", path: `${Q}/inquire-daily-overtimeprice`, trId: "FHPST02320000", params: { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: STOCK } },
  { id: "P8b", item: "시간외 시간별 체결(당일)", path: `${Q}/inquire-time-overtimeconclusion`, trId: "FHPST02310000", params: { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: STOCK, FID_HOUR_CLS_CODE: "1" } },
  { id: "P9a", item: "주식현재가 일자별(외국인 소진율·순매수 수량 필드), 일", path: `${Q}/inquire-daily-price`, trId: "FHKST01010400", params: { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: STOCK, FID_PERIOD_DIV_CODE: "D", FID_ORG_ADJ_PRC: "0" } },
  { id: "P9b", item: "주식현재가 일자별, 월봉(깊이 확인)", path: `${Q}/inquire-daily-price`, trId: "FHKST01010400", params: { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: STOCK, FID_PERIOD_DIV_CODE: "M", FID_ORG_ADJ_PRC: "0" } },
  { id: "P10a", item: "일별 분봉 조회, 1개월 전(20261001)", path: `${Q}/inquire-time-dailychartprice`, trId: "FHKST03010230", params: { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: STOCK, FID_INPUT_HOUR_1: "153000", FID_INPUT_DATE_1: "20261001", FID_PW_DATA_INCU_YN: "Y", FID_FAKE_TICK_INCU_YN: "" } },
  { id: "P10b", item: "일별 분봉 조회, 6개월 전(20260504)", path: `${Q}/inquire-time-dailychartprice`, trId: "FHKST03010230", params: { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: STOCK, FID_INPUT_HOUR_1: "153000", FID_INPUT_DATE_1: "20260504", FID_PW_DATA_INCU_YN: "Y", FID_FAKE_TICK_INCU_YN: "" } },
  { id: "P10c", item: "일별 분봉 조회, 12개월 전(20251104)", path: `${Q}/inquire-time-dailychartprice`, trId: "FHKST03010230", params: { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: STOCK, FID_INPUT_HOUR_1: "153000", FID_INPUT_DATE_1: "20251104", FID_PW_DATA_INCU_YN: "Y", FID_FAKE_TICK_INCU_YN: "" } },
  { id: "P11a", item: "국내주식 공매도 일별추이, 최근", path: `${Q}/daily-short-sale`, trId: "FHPST04830000", params: { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: STOCK, FID_INPUT_DATE_1: "20261001", FID_INPUT_DATE_2: "20261104" } },
  { id: "P11b", item: "국내주식 공매도 일별추이, 2015", path: `${Q}/daily-short-sale`, trId: "FHPST04830000", params: { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: STOCK, FID_INPUT_DATE_1: "20150105", FID_INPUT_DATE_2: "20150130" } },
  { id: "P12a", item: "종목별 일별 대차거래추이, 최근", path: `${Q}/daily-loan-trans`, trId: "HHPST074500C0", params: { MRKT_DIV_CLS_CODE: "1", MKSC_SHRN_ISCD: STOCK, START_DATE: "20261001", END_DATE: "20261104", CTS: "" } },
  { id: "P12b", item: "종목별 일별 대차거래추이, 2015", path: `${Q}/daily-loan-trans`, trId: "HHPST074500C0", params: { MRKT_DIV_CLS_CODE: "1", MKSC_SHRN_ISCD: STOCK, START_DATE: "20150105", END_DATE: "20150130", CTS: "" } },
  { id: "P13a", item: "국내주식 신용잔고 일별추이, 최근", path: `${Q}/daily-credit-balance`, trId: "FHPST04760000", params: { FID_COND_MRKT_DIV_CODE: "J", FID_COND_SCR_DIV_CODE: "20476", FID_INPUT_ISCD: STOCK, FID_INPUT_DATE_1: "20261104" } },
  { id: "P13b", item: "국내주식 신용잔고 일별추이, 2015", path: `${Q}/daily-credit-balance`, trId: "FHPST04760000", params: { FID_COND_MRKT_DIV_CODE: "J", FID_COND_SCR_DIV_CODE: "20476", FID_INPUT_ISCD: STOCK, FID_INPUT_DATE_1: "20150130" } },
  { id: "P14", item: "종목별 외국계 순매수추이", path: `${Q}/frgnmem-pchs-trend`, trId: "FHKST644400C0", params: { FID_INPUT_ISCD: STOCK, FID_INPUT_ISCD_2: "99999", FID_COND_MRKT_DIV_CODE: "J" } },
  { id: "P15", item: "상장폐지 종목 커버리지: 기간별 시세(한진해운 2017-04 마지막 거래 구간)", path: `${Q}/inquire-daily-itemchartprice`, trId: "FHKST03010100", params: { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: DELISTED, FID_INPUT_DATE_1: "20170101", FID_INPUT_DATE_2: "20170430", FID_PERIOD_DIV_CODE: "D", FID_ORG_ADJ_PRC: "0" } },
  // ---- 2차 호출(1차 결과로 호출당 행 수·깊이·종목 단위 파라미터를 확인하기 위한 재호출) ----
  { id: "P1c", item: "프로그램매매 종합현황(일별) 시장 단위, 2011년 1년 범위(호출당 행 수 상한)", path: `${Q}/comp-program-trade-daily`, trId: "FHPPG04600001", params: { FID_COND_MRKT_DIV_CODE: "J", FID_MRKT_CLS_CODE: "K", FID_INPUT_DATE_1: "20110103", FID_INPUT_DATE_2: "20111230" } },
  { id: "P2c", item: "종목별 프로그램매매추이(일별), 2011 기준일(깊이)", path: `${Q}/program-trade-by-stock-daily`, trId: "FHPPG04650200", params: { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: STOCK, FID_INPUT_DATE_1: "20110131" } },
  { id: "P2d", item: "종목별 프로그램매매추이(일별), 상장폐지 종목(한진해운) 기준일 2017-03-06", path: `${Q}/program-trade-by-stock-daily`, trId: "FHPPG04650200", params: { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: DELISTED, FID_INPUT_DATE_1: "20170306" } },
  { id: "P4c", item: "종목별 일별 매수매도 체결량, 2011년 1년 범위(호출당 행 수 상한)", path: `${Q}/inquire-daily-trade-volume`, trId: "FHKST03010800", params: { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: STOCK, FID_PERIOD_DIV_CODE: "D", FID_INPUT_DATE_1: "20110103", FID_INPUT_DATE_2: "20111230" } },
  { id: "P7c", item: "VI 발동 현황(날짜 지정), 2015", path: `${Q}/inquire-vi-status`, trId: "FHPST01390000", params: { FID_DIV_CLS_CODE: "0", FID_COND_SCR_DIV_CODE: "20139", FID_MRKT_CLS_CODE: "0", FID_INPUT_ISCD: "", FID_RANK_SORT_CLS_CODE: "0", FID_INPUT_DATE_1: "20150105", FID_TRGT_CLS_CODE: "", FID_TRGT_EXLS_CLS_CODE: "" } },
  { id: "P8c", item: "시간외 일자별 주가 전체 행(시간외 거래량·종가 값이 있는지)", path: `${Q}/inquire-daily-overtimeprice`, trId: "FHPST02320000", params: { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: STOCK }, show: ["stck_bsop_date", "ovtm_untp_prpr", "ovtm_untp_vol", "ovtm_untp_tr_pbmn", "stck_clpr", "acml_vol"] },
  { id: "P10d", item: "일별 분봉 조회, 약 22개월 전(20250102)", path: `${Q}/inquire-time-dailychartprice`, trId: "FHKST03010230", params: { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: STOCK, FID_INPUT_HOUR_1: "153000", FID_INPUT_DATE_1: "20250102", FID_PW_DATA_INCU_YN: "Y", FID_FAKE_TICK_INCU_YN: "" } },
  { id: "P10e", item: "일별 분봉 조회, 약 34개월 전(20240102)", path: `${Q}/inquire-time-dailychartprice`, trId: "FHKST03010230", params: { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: STOCK, FID_INPUT_HOUR_1: "153000", FID_INPUT_DATE_1: "20240102", FID_PW_DATA_INCU_YN: "Y", FID_FAKE_TICK_INCU_YN: "" } },
  { id: "P10f", item: "일별 분봉 조회, 약 58개월 전(20220103)", path: `${Q}/inquire-time-dailychartprice`, trId: "FHKST03010230", params: { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: STOCK, FID_INPUT_HOUR_1: "153000", FID_INPUT_DATE_1: "20220103", FID_PW_DATA_INCU_YN: "Y", FID_FAKE_TICK_INCU_YN: "" } },
  { id: "P11c", item: "국내주식 공매도 일별추이, 2011년 1년 범위(깊이·호출당 행 수 상한)", path: `${Q}/daily-short-sale`, trId: "FHPST04830000", params: { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: STOCK, FID_INPUT_DATE_1: "20110103", FID_INPUT_DATE_2: "20111230" } },
  { id: "P11d", item: "국내주식 공매도 일별추이, 상장폐지 종목(한진해운) 2017-01~03", path: `${Q}/daily-short-sale`, trId: "FHPST04830000", params: { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: DELISTED, FID_INPUT_DATE_1: "20170102", FID_INPUT_DATE_2: "20170306" } },
  { id: "P12c", item: "종목별 일별 대차거래추이(종목 단위 MRKT_DIV_CLS_CODE=3), 2015", path: `${Q}/daily-loan-trans`, trId: "HHPST074500C0", params: { MRKT_DIV_CLS_CODE: "3", MKSC_SHRN_ISCD: STOCK, START_DATE: "20150105", END_DATE: "20150130", CTS: "" } },
  { id: "P12d", item: "종목별 일별 대차거래추이(종목 단위), 2011년 1년 범위(깊이·호출당 행 수 상한)", path: `${Q}/daily-loan-trans`, trId: "HHPST074500C0", params: { MRKT_DIV_CLS_CODE: "3", MKSC_SHRN_ISCD: STOCK, START_DATE: "20110103", END_DATE: "20111230", CTS: "" } },
  { id: "P13c", item: "국내주식 신용잔고 일별추이, 2011 기준일(깊이)", path: `${Q}/daily-credit-balance`, trId: "FHPST04760000", params: { FID_COND_MRKT_DIV_CODE: "J", FID_COND_SCR_DIV_CODE: "20476", FID_INPUT_ISCD: STOCK, FID_INPUT_DATE_1: "20110131" } },
  { id: "P16", item: "주식현재가 회원사 종목매매동향(일별 거래원)", path: `${Q}/inquire-member-daily`, trId: "FHPST04540000", params: { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: STOCK, FID_INPUT_ISCD_2: "99999", FID_INPUT_DATE_1: "20261001", FID_INPUT_DATE_2: "20261104", FID_SCTN_CLS_CODE: "" } },
  { id: "P12e", item: "종목별 일별 대차거래추이(종목 단위), 2013년 1년 범위(시작 시점 좁히기)", path: `${Q}/daily-loan-trans`, trId: "HHPST074500C0", params: { MRKT_DIV_CLS_CODE: "3", MKSC_SHRN_ISCD: STOCK, START_DATE: "20130102", END_DATE: "20131230", CTS: "" } },
  { id: "P12f", item: "종목별 일별 대차거래추이(종목 단위), 2014년 1년 범위(시작 시점 좁히기)", path: `${Q}/daily-loan-trans`, trId: "HHPST074500C0", params: { MRKT_DIV_CLS_CODE: "3", MKSC_SHRN_ISCD: STOCK, START_DATE: "20140102", END_DATE: "20141230", CTS: "" } },
  { id: "P16b", item: "주식현재가 회원사 종목매매동향(일별 거래원), 2011년 범위(깊이)", path: `${Q}/inquire-member-daily`, trId: "FHPST04540000", params: { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: STOCK, FID_INPUT_ISCD_2: "99999", FID_INPUT_DATE_1: "20110103", FID_INPUT_DATE_2: "20110131", FID_SCTN_CLS_CODE: "" } },
  { id: "P12g", item: "종목별 일별 대차거래추이(종목 단위), 2015년 1년 범위(호출당 행 수 상한 확정)", path: `${Q}/daily-loan-trans`, trId: "HHPST074500C0", params: { MRKT_DIV_CLS_CODE: "3", MKSC_SHRN_ISCD: STOCK, START_DATE: "20150102", END_DATE: "20151230", CTS: "" } },
  { id: "P4d", item: "종목별 일별 매수매도 체결량, 2010년 1년 범위(2010 시작 가능 여부)", path: `${Q}/inquire-daily-trade-volume`, trId: "FHKST03010800", params: { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: STOCK, FID_PERIOD_DIV_CODE: "D", FID_INPUT_DATE_1: "20100104", FID_INPUT_DATE_2: "20101230" } },
  { id: "P1d", item: "프로그램매매 종합현황(일별) 코스닥(Q), 2011-01", path: `${Q}/comp-program-trade-daily`, trId: "FHPPG04600001", params: { FID_COND_MRKT_DIV_CODE: "J", FID_MRKT_CLS_CODE: "Q", FID_INPUT_DATE_1: "20110103", FID_INPUT_DATE_2: "20110131" } },
  { id: "P1e", item: "프로그램매매 종합현황(일별) 코스피(K), 2010년 1년 범위(2010 시작 가능 여부)", path: `${Q}/comp-program-trade-daily`, trId: "FHPPG04600001", params: { FID_COND_MRKT_DIV_CODE: "J", FID_MRKT_CLS_CODE: "K", FID_INPUT_DATE_1: "20100104", FID_INPUT_DATE_2: "20101230" } },
];
const KRX: KrxProbe[] = [
  { id: "K1a", item: "KRX 파생상품지수 일별(VKOSPI 등), 최근", endpoint: "idx/drvprod_dd_trd", basDd: "20261104" },
  { id: "K1b", item: "KRX 파생상품지수 일별, 2011", endpoint: "idx/drvprod_dd_trd", basDd: "20110103" },
  { id: "K2", item: "KRX 선물 일별매매정보", endpoint: "drv/fut_bydd_trd", basDd: "20261104" },
  { id: "K3", item: "KRX 옵션 일별매매정보", endpoint: "drv/opt_bydd_trd", basDd: "20261104" },
  { id: "K4a", item: "KRX 코스닥 일별매매정보(소속부 SECT_TP_NM 분포), 최근", endpoint: "sto/ksq_bydd_trd", basDd: "20261104" },
  { id: "K4b", item: "KRX 코스닥 일별매매정보(소속부 SECT_TP_NM 분포), 2012", endpoint: "sto/ksq_bydd_trd", basDd: "20120102" },
  { id: "K4c", item: "KRX 코스피 일별매매정보(소속부 SECT_TP_NM 분포), 최근", endpoint: "sto/stk_bydd_trd", basDd: "20261104" },
  { id: "K5", item: "KRX 유가증권 종목기본정보", endpoint: "sto/stk_isu_base_info", basDd: "20261104" },
  { id: "K5b", item: "KRX 유가증권 종목기본정보, 과거 기준일 2012-01-02(과거 스냅샷·상장폐지 종목 포함 여부)", endpoint: "sto/stk_isu_base_info", basDd: "20120102" },
];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const trunc = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/** 응답의 배열·객체 필드를 요약한다(행 수, 필드 이름, 첫/끝 행). */
function summarize(body: Record<string, unknown>): string[] {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(body)) {
    if (["rt_cd", "msg_cd", "msg1"].includes(k)) continue;
    if (Array.isArray(v)) {
      const rows = v as Record<string, unknown>[];
      lines.push(`  ${k}: 배열 ${rows.length}행${rows.length ? `, 필드 ${Object.keys(rows[0]).join(",")}` : ""}`);
      if (rows.length) { lines.push(`    첫 행: ${trunc(JSON.stringify(rows[0]), 700)}`); if (rows.length > 1) lines.push(`    끝 행: ${trunc(JSON.stringify(rows[rows.length - 1]), 700)}`); }
    } else if (v && typeof v === "object") {
      lines.push(`  ${k}: 객체 필드 ${Object.keys(v as object).join(",")}`);
      lines.push(`    값: ${trunc(JSON.stringify(v), 900)}`);
    } else lines.push(`  ${k}: ${trunc(String(v), 120)}`);
  }
  return lines;
}

async function main(): Promise<void> {
  const kst = new Date(Date.now() + 9 * 3600_000), hm = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  console.log(`데이터 가용성 점검 2 시작: ${new Date().toISOString()} (KST ${String(kst.getUTCHours()).padStart(2, "0")}:${String(kst.getUTCMinutes()).padStart(2, "0")})`);
  if (hm >= 14 * 60 && hm < 15 * 60 + 40) throw new Error("KST 14:00~15:40에는 KIS·KRX를 호출하지 않는다 — 실행 거부");
  const only = (process.env.FEAS_ONLY ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const SECOND = new Set(["P1c","P2c","P2d","P4c","P7c","P8c","P10d","P10e","P10f","P11c","P11d","P12c","P12d","P13c","P16","P12e","P12f","P16b","K5b","P12g","P4d","P1d","P1e"]);
  const want = (id: string): boolean => only.length === 0 || only.includes("all") ? !SECOND.has(id) : only.includes(id);
  let nKis = 0, nKrx = 0;
  for (const p of KIS.filter((x) => want(x.id))) {
    console.log(`\n### ${p.id} — ${p.item}\n  요청: ${p.path.replace("/uapi/domestic-stock/v1/", "")} TR ${p.trId} 파라미터 ${JSON.stringify(p.params)}`);
    try {
      nKis++;
      const body = await kisGetForResearch(p.path, p.trId, p.params, 1);
      console.log(`  결과: 성공 rt_cd=${String(body.rt_cd)} msg=${trunc(String(body.msg1 ?? ""), 100)}`);
      for (const l of summarize(body)) console.log(l);
      if (p.show) {
        const arr = (Object.values(body).filter((v) => Array.isArray(v)).pop() ?? []) as Record<string, unknown>[];
        for (const r of arr) console.log(`    ${p.show.map((k) => String(r[k])).join(" | ")}`);
      }
    } catch (e) {
      console.log(`  결과: 오류 ${trunc(e instanceof Error ? e.message : String(e), 400)}`);
    }
    await sleep(SLEEP_MS);
  }
  const key = process.env.KRX_API_KEY;
  if (!key && KRX.some((x) => want(x.id))) throw new Error("KRX_API_KEY 없음");
  for (const p of KRX.filter((x) => want(x.id))) {
    console.log(`\n### ${p.id} — ${p.item}\n  요청: ${p.endpoint}?basDd=${p.basDd}`);
    try {
      nKrx++;
      const res = await fetch(`${KRX_BASE}/${p.endpoint}?basDd=${p.basDd}`, { headers: { AUTH_KEY: key as string } });
      const text = await res.text();
      let body: Record<string, unknown> | null = null;
      try { body = JSON.parse(text) as Record<string, unknown>; } catch { /* 비 JSON */ }
      console.log(`  결과: HTTP ${res.status}, ${(text.length / 1024).toFixed(1)} KiB${body ? "" : `, 본문 ${trunc(text, 200)}`}`);
      if (body) {
        for (const l of summarize(body)) console.log(l);
        const blk = Object.values(body).find((v) => Array.isArray(v)) as Record<string, unknown>[] | undefined;
        if (blk?.length && "SECT_TP_NM" in blk[0]) {
          const cnt = new Map<string, number>();
          for (const r of blk) cnt.set(String(r.SECT_TP_NM), (cnt.get(String(r.SECT_TP_NM)) ?? 0) + 1);
          console.log(`  SECT_TP_NM 분포: ${[...cnt].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k || "(빈 값)"} ${v}`).join(", ")}`);
        }
      }
    } catch (e) {
      console.log(`  결과: 오류 ${trunc(e instanceof Error ? e.message : String(e), 400)}`);
    }
    await sleep(SLEEP_MS);
  }
  console.log(`\n점검 종료: KIS 시험 호출 ${nKis}회, KRX 시험 호출 ${nKrx}회 | Supabase 쓴 행 0(연구 데이터; KIS 토큰은 운영 토큰 행을 읽고 만료 시에만 기존 경로로 갱신) | Storage 쓰기 0 | DART 호출 0 | 응답 저장 없음`);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });
