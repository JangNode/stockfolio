// KODEX 200 + 업종 모멘텀 위성 전략 기준값. 규칙은 연구 사전등록을 그대로 옮긴다(변경 금지):
// research/kodex-sector-satellite-v3-prereg.md(a55a878) · v3_1(b01d69f) · v3_2(d70b1fd),
// 바탕 유니버스·제외 규칙은 research/sector-mom-tilt-v2_1-prereg.md(e1ab2e6)·satellite-v1_2-prereg.md(4c1557a)
// (연구 브랜치 claude/ma-v3-portfolio-cap-run).

/** 바탕 ETF(KODEX 200). */
export const KSS_ETF_CODE = "069500";
export const KSS_ETF_NAME = "KODEX 200";

/** 바탕 K200P: 신호일 KOSPI 상장 종목 중 시총 상위 200. 유동성(20일 평균 거래대금 5억)은 lib/strategyBacktestSummaryConfig.ts의 PIT_* 값을 그대로 쓴다. */
export const KSS_K200P_SIZE = 200;

/** 제외 규칙(4c1557a): 우선주(코드 끝자리 ≠ '0'), 스팩, 이름이 "리츠"로 끝남, 업종 642·681, 명시 코드(맥쿼리인프라·KB발해인프라·맵스리얼티). */
export const KSS_SPAC_NAME_KEYWORDS = ["스팩", "기업인수목적"] as const;
export const KSS_REIT_NAME_SUFFIX = "리츠";
export const KSS_REIT_KSIC_PREFIXES = ["642", "681"] as const;
export const KSS_EXPLICIT_EXCLUDED_CODES = ["088980", "415640", "094800"] as const;

/** 업종 = stock_industry_classification.induty_code 앞 2자리. 업종 모멘텀 = 업종 내 시총가중 수익률(6개월 전 월말 ~ 1개월 전 월말). */
export const KSS_SECTOR_CODE_LENGTH = 2;
export const KSS_MOMENTUM_LOOKBACK_MONTHS = 6;
export const KSS_MOMENTUM_SKIP_MONTHS = 1;
export const KSS_MIN_SECTOR_STOCKS = 2;
export const KSS_TOP_SECTORS = 3;
export const KSS_STOCKS_PER_SECTOR = 3;

/** 비중: 069500 80% : 위성 20%. 위성 종목 중 계좌 전체 비중 1.0% 미만은 빼고 재분배(v3.2). */
export const KSS_SATELLITE_WEIGHT = 0.2;
export const KSS_TRIM_MIN_ACCOUNT_WEIGHT = 0.01;

/** 실제 계좌(정수 주) 규칙(v3.2 B): 위성 평가 합계 상한 30%, 069500 슬리피지 편도 0.05%(주식 비용은 lib/transactionCost.ts). */
export const KSS_SATELLITE_CAP = 0.3;
export const KSS_ETF_SLIPPAGE = 0.0005;

/** 모의 추적 시드(원)와 화면 시드 버튼. */
export const KSS_SEEDS_WON = [1_000_000, 3_000_000, 5_000_000, 7_000_000, 10_000_000] as const;

/** 업종 코드 앞 2자리 이름(통계청 한국표준산업분류 10차의 2자리 분류). 화면 표시용. */
export const KSS_SECTOR_NAMES: Record<string, string> = {
  "01": "농업", "02": "임업", "03": "어업", "05": "석탄·원유·천연가스 광업", "06": "금속 광업", "07": "비금속광물 광업", "08": "광업 지원 서비스",
  "10": "식료품", "11": "음료", "12": "담배", "13": "섬유제품", "14": "의복·모피", "15": "가죽·가방·신발", "16": "목재·나무제품", "17": "펄프·종이",
  "18": "인쇄·기록매체 복제", "19": "코크스·석유정제품", "20": "화학물질·화학제품", "21": "의료용 물질·의약품", "22": "고무·플라스틱", "23": "비금속 광물제품",
  "24": "1차 금속", "25": "금속가공제품", "26": "전자부품·컴퓨터·통신장비", "27": "의료·정밀·광학기기", "28": "전기장비", "29": "기타 기계·장비",
  "30": "자동차·트레일러", "31": "기타 운송장비", "32": "가구", "33": "기타 제품", "34": "산업용 기계·장비 수리", "35": "전기·가스·증기 공급",
  "36": "수도", "37": "하수·폐수 처리", "38": "폐기물 처리·원료 재생", "39": "환경 정화·복원", "41": "종합 건설", "42": "전문직별 공사",
  "45": "자동차·부품 판매", "46": "도매·상품 중개", "47": "소매", "49": "육상 운송", "50": "수상 운송", "51": "항공 운송", "52": "창고·운송 관련 서비스",
  "55": "숙박", "56": "음식점·주점", "58": "출판", "59": "영상·오디오 제작·배급", "60": "방송", "61": "우편·통신", "62": "컴퓨터 프로그래밍·시스템 통합",
  "63": "정보 서비스", "64": "금융", "65": "보험·연금", "66": "금융·보험 관련 서비스", "68": "부동산", "70": "연구개발", "71": "전문 서비스",
  "72": "건축기술·엔지니어링", "73": "기타 전문·과학·기술 서비스", "74": "사업시설 관리·조경", "75": "사업 지원 서비스", "76": "임대(부동산 제외)",
  "84": "공공 행정", "85": "교육", "86": "보건", "87": "사회복지", "90": "창작·예술·여가", "91": "스포츠·오락", "94": "협회·단체", "95": "개인·소비용품 수리", "96": "기타 개인 서비스",
};

/** KRX Open API(주식·ETF 일별매매정보). 인증 헤더 AUTH_KEY = GitHub Secret KRX_API_KEY. */
export const KSS_KRX_BASE_URL = "https://data-dbg.krx.co.kr/svc/apis";

/** 연구 성적표(가격 기준, 개발 데이터 내 성적) — research v3.2 실행(0158359, run 39697841491) 로그의 A 80:20 표. */
export const KSS_RESEARCH_SCORECARD = {
  source: "연구 v3.2(사전등록 d70b1fd, 실행 0158359)",
  periods: [
    { label: "2010-07~2016", strategyCagr: 3.62, strategyMdd: 27.13, strategySharpe: 0.3, etfCagr: 2.83, etfMdd: 27.85, etfSharpe: 0.26 },
    { label: "2017~2021", strategyCagr: 10.19, strategyMdd: 44.36, strategySharpe: 0.63, etfCagr: 8.66, etfMdd: 40.65, etfSharpe: 0.56 },
    { label: "2022~2026-10", strategyCagr: 19.06, strategyMdd: 42.83, strategySharpe: 0.69, etfCagr: 17.72, etfMdd: 41.34, etfSharpe: 0.68 },
    { label: "전 기간", strategyCagr: 9.99, strategyMdd: 44.36, strategySharpe: 0.53, etfCagr: 8.82, etfMdd: 41.34, etfSharpe: 0.49 },
  ],
} as const;

/** 운영 배치(scripts/kodex-sector-signal.ts) 값. */
// 신호일 KOSPI 응답 행 수 하한 — KOSPI 상장 종목은 우선주 포함 900개 안팎(2026-10 기준)이라 이보다 크게
// 적으면 정산 전 부분 응답이나 응답 구조 변경으로 보고 그 달 신호를 저장하지 않는다(SKILLS.md 파서 검증 원칙).
export const KSS_KRX_KOSPI_MIN_ROWS = 700;
// 모멘텀 시작 월말 앞 여유(달력 일). "시작 월말 이하 마지막 행"을 찾기 위해 그 달 전체를 더 읽는다.
export const KSS_HISTORY_PAD_DAYS = 31;
// 직전·다음 거래일(신호일·체결일)을 캘린더에서 찾는 범위(달력 일). 설·추석 연휴도 10일 안에 끝난다.
export const KSS_NEXT_TRADING_DAY_SEARCH_DAYS = 10;
// 모의 추적에서 그날 행이 없는 종목(거래정지 등)의 직전 종가를 찾는 범위(달력 일, 연구 B는 기간 제한 없는 직전 종가).
export const KSS_PRICE_LOOKBACK_DAYS = 31;
