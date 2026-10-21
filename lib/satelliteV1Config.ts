// 위성 전략 v1(scripts/research-satellite-v1.ts, research/satellite-v1-prereg.md) 기준값. 모두 사용자 사전등록(2026-10-21).

/** 보유 종목 수, 보유 유지 순위(점수 순위가 이 안이면 유지). */
export const SAT_HOLD_COUNT = 20;
export const SAT_KEEP_RANK = 40;
/** C1 상위 몇 분의 1을 뺄지(3 = 상위 1/3). */
export const SAT_C1_EXCLUDE_PARTS = 3;
/** 매수 지연: 외국인 순매수 합산 창(거래일), 상위 비율(10 = 상위 1/10), 지연 거래일. */
export const SAT_FLOW_DAYS = 5;
export const SAT_FLOW_TOP_PARTS = 10;
export const SAT_BUY_DELAY_DAYS = 5;
/** 조합: 위성 비중(P100, P90, P80, P70, P60, P50, P0 순), 되돌림 허용 폭, 069500 편도 비용(수수료 0.015% + 0.05%). */
export const SAT_MIX_WEIGHTS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 1.0] as const;
export const SAT_MIX_BAND = 0.05;
export const SAT_ETF_COST_PER_SIDE = 0.00015 + 0.0005;
/** 비중 선택: 학습 CAGR ≥ B&H − 0.5%p, MDD ≤ B&H. 해당 없으면 기본 표시 비중(P80 = 위성 0.2). */
export const SAT_MIX_CAGR_TOL_PP = 0.5;
export const SAT_MIX_DEFAULT_W = 0.2;
/** 참고 기준(위성 단독): CAGR ≥ PEW + 2.0%p, MDD ≤ B&H + 10%p, 지연 하락 ≤ 1.0%p. */
export const SAT_REF_PEW_MARGIN_PP = 2.0;
export const SAT_REF_MDD_MARGIN_PP = 10.0;
export const SAT_REF_MAX_DELAY_DROP_PP = 1.0;
/** 스팩 식별 이름 키워드(dart_corp_codes.corp_name). */
export const SAT_SPAC_NAME_KEYWORDS = ["스팩", "기업인수목적"] as const;

// ---- v1.1 (research/satellite-v1_1-prereg.md, 사용자 지정 2026-10-21) ----
/** 부동산·인프라 투자회사 식별: 이름 키워드(dart_corp_codes.corp_name, 대소문자 무시), 업종 코드 접두(KSIC 642 신탁업 및 집합투자업). */
export const SAT_REIT_NAME_KEYWORDS = ["리츠", "REIT", "인프라", "맵스", "선박", "부동산투자"] as const;
export const SAT_REIT_KSIC_PREFIX = "642";
/** MDD 비교 허용오차. */
export const SAT_MDD_EPS = 1e-9;
/** R1 주변 값: 보유 수(유지 순위 = 보유 수 × SAT_KEEP_MULT), VOL 창, 신용 제외 분할 수. */
export const SAT_KEEP_MULT = 2;
export const SAT_R1_HOLD_COUNTS = [15, 30] as const;
export const SAT_R1_VOL_DAYS = [40, 90] as const;
export const SAT_R1_C1_PARTS = [4, 2] as const;
/** R3 무작위 비교 횟수·시드. */
export const SAT_R3_DRAWS = 1000;
export const SAT_R3_SEED = 20261021;
/** induty_code 앞 2자리 이름(통계청 한국표준산업분류 10차(2017)의 2자리 분류, 이 저장소에서는 lib/industryPerConfig.ts를 따라 "대분류"라 부름). 업종 표시용. */
export const SAT_KSIC_DIVISION_NAMES: Record<string, string> = {
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
