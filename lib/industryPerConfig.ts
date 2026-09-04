// 적정주가 방법A(업종 평균 PER) 기준값.

// DART induty_code 앞 2자리(KSIC 대분류) 기준 그룹핑. induty_code 자릿수는 종목마다
// 다르지만(삼성전자 "264" 3자리, SK하이닉스 "2612" 4자리, 현대차 "30121" 5자리)
// 앞 2자리는 일관되게 KSIC 대분류를 나타낸다(2026-09-04 실측 확인,
// scripts/diagnose-dart-company-overview.ts 결과 반영).
export const INDUSTRY_GROUP_KSIC_PREFIX_LENGTH = 2;

// 업종 평균 PER 산출에 필요한 최소 표본 종목 수. 미달 그룹은 median_per를 null로
// 저장해 산출 불가 근거로 쓴다.
export const INDUSTRY_PEER_MIN_GROUP_SIZE = 3;
