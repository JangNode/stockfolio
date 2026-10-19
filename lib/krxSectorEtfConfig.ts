// 업종 ETF 유니버스 점검(scripts/probe-krx-sector-etf.ts) 기준값. 키워드는 사용자 지정(2026-10-19) + 같은 성격의 "등" 확장 항목(아래 표시).

/** KRX 요청 상한(사용자 확정 30건)과 요청 간 간격(ms). */
export const KRX_SECTOR_ETF_REQUEST_CAP = 30;
export const KRX_SECTOR_ETF_GAP_MS = 300;

/** 조회 날짜(사용자 지정). 마지막 날짜가 현재 기준일. */
export const KRX_SECTOR_ETF_DATES = ["20100104", "20110103", "20120102", "20130102", "20150102", "20180102", "20261016"] as const;
export const KRX_SECTOR_ETF_LAST_DATE = "20261016";
/** 업종 수를 세는 시점(사용자 지정, 앞 4개 날짜). */
export const KRX_SECTOR_ETF_COUNT_DATES = ["20100104", "20110103", "20120102", "20130102"] as const;

/** 업종 키워드 → 업종명. 앞에서부터 처음 맞는 항목을 쓴다(구체적인 것을 앞에 둠). 사용자 지정 목록 뒤의 항목은 "등"에 해당하는 확장. */
export const KRX_SECTOR_KEYWORDS: { sector: string; re: RegExp }[] = [
  { sector: "2차전지", re: /2차전지|배터리/ },
  { sector: "반도체", re: /반도체/ },
  { sector: "소프트웨어", re: /소프트웨어/ },
  { sector: "IT", re: /(^|[^A-Za-z])IT([^A-Za-z]|$)|정보기술/ },
  { sector: "자동차", re: /자동차/ },
  { sector: "조선", re: /조선/ },
  { sector: "철강", re: /철강/ },
  { sector: "에너지화학", re: /에너지화학/ },
  { sector: "화학", re: /화학/ },
  { sector: "에너지", re: /에너지/ },
  { sector: "건설", re: /건설/ },
  { sector: "은행", re: /은행/ },
  { sector: "증권", re: /증권/ },
  { sector: "보험", re: /보험/ },
  { sector: "금융", re: /금융/ },
  { sector: "헬스케어", re: /헬스케어/ },
  { sector: "바이오", re: /바이오/ },
  { sector: "필수소비재", re: /필수소비재/ },
  { sector: "경기소비재", re: /경기소비재/ },
  { sector: "미디어", re: /미디어/ },
  { sector: "운송", re: /운송/ },
  { sector: "기계", re: /기계/ },
  { sector: "산업재", re: /산업재/ },
  { sector: "유틸리티", re: /유틸리티/ },
  { sector: "통신", re: /통신/ },
  // ---- "등" 확장 ----
  { sector: "게임", re: /게임/ },
  { sector: "인터넷", re: /인터넷/ },
  { sector: "방산·항공우주", re: /방산|항공우주|우주항공/ },
  { sector: "음식료", re: /음식료|식품/ },
  { sector: "화장품", re: /화장품|코스메틱/ },
  { sector: "부동산·리츠", re: /리츠|부동산/ },
  { sector: "원자력", re: /원자력|원전/ },
  { sector: "로봇", re: /로봇/ },
];

/** 제외 사유 판정(위에서부터 처음 맞는 사유). */
export const KRX_SECTOR_EXCLUDE: { reason: string; re: RegExp }[] = [
  { reason: "레버리지", re: /레버리지|2X|3X|곱버스/i },
  { reason: "인버스", re: /인버스/ },
  { reason: "채권", re: /채권|국고채|회사채|금리|CD|머니마켓|통안채|KOFR|단기자금/ },
  { reason: "원자재", re: /골드|금현물|원유|구리|농산물|WTI|원자재|은선물|팔라듐|콩|옥수수/ },
  { reason: "통화", re: /달러|엔선물|위안|유로선물|통화/ },
  { reason: "액티브(테마형)", re: /액티브|ACTIVE/i },
];
/** 해외 지수 판정: 해외 표지가 있고 국내 표지가 없으면 제외. */
export const KRX_SECTOR_FOREIGN_RE = /미국|나스닥|필라델피아|S&P|차이나|중국|일본|인도|베트남|유로|유럽|글로벌|선진국|신흥국|항셍|홍콩|대만|브라질|러시아|MSCI World|NASDAQ|NYSE|해외|STOXX|Nikkei|CSI/i;
export const KRX_SECTOR_DOMESTIC_RE = /KRX|코스피|KOSPI|코스닥|KOSDAQ|한국|FnGuide|에프앤가이드|WISE|iSelect|MKF|Fn /i;
