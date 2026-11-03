// DS4 후속 진단(시험 아님, 시험 번호 269 유지) 기준값. 사용자 지정 2026-11-03. 문서: docs/research/ds4-forward.md, docs/research/ds4-followup-diagnostic.md
// DS4 정의는 연구 DS4(커밋 2b72658)의 "고정판"이며 이 파일의 값으로 바꾸지 않는다. 아래는 재현 확인과 보고에만 쓴다.
/** 고정판 기록: 코어 40% + PE4 20% 상한 위성의 평가 구간 전체 CAGR / MDD (연구 DS4 시험 기록). 소수 둘째 자리까지 같아야 하고, 다르면 중단한다. */
export const DS4_FIXED_REF = { cagr: 15.2, mdd: 33.11 } as const;
/** 고정 날짜: 설계·시험에 쓴 가격 스냅샷의 데이터 끝 날짜. 이 날짜 이후 데이터는 DS4 설계에 쓰이지 않았다. */
export const DS4_FREEZE_DATE = "2026-10-26";
/** 코어 제외 진단: 코어 순위 목록에서 뺄 종목(삼성전자, SK하이닉스). */
export const DS4_EXCLUDE_CORE = ["005930", "000660"] as const;
