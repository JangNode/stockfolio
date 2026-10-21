# 월말 시장 구분 수집 → v2.1 재판정 기록 (시도 142 유지, 추가 시도 아님)

v2.1(e1ab2e6)은 0단계에서 시장 미상 시총 비율 5% 초과(2010~2015)로 멈췄다(c8b1cff 실행). 사용자 지시(2026-10-21)로 월말 시장 구분을 수집하고, 0단계를 이 목록으로 다시 판정한 뒤 통과하면 v2.1을 사전등록 그대로 1회 실행한다. v2.1의 정의·기준·튼튼함 검사는 e1ab2e6 그대로이며, 바뀌는 것은 시장 구분 출처(stock_beta 현재 값 → 신호일 월말 목록 값)뿐이다.

## 수집 (scripts/collect-market-membership.ts, 기준값 lib/marketMembershipConfig.ts)

- KRX Open API `sto/stk_bydd_trd`(KOSPI), `sto/ksq_bydd_trd`(KOSDAQ), 인증 헤더 AUTH_KEY(GitHub Secret KRX_API_KEY). 2010-01~2026-10 매월 마지막 거래일(가격 Parquet 달력 기준; 2026-10은 달력 마지막 날) × 2시장, 각 1회. 외부 요청 상한 500건(재시도 포함, 실패 시 1.5초 뒤 최대 2회 재시도, 요청 간격 0.3초).
- 저장: Storage `research/market_membership/month_end.parquet`(컬럼 trade_date, stock_code, market만), 수집 기록 `_log.json`(요청 수, 빈 응답 날짜·시장, 실패). DB 쓰기 0. 종목코드는 ISU_SRT_CD(6자리)가 있으면 그 값, ISU_CD가 6자리면 그대로, 12자리 ISIN이면 4~9번째 자리로 정규화.
- 이어받기: 이미 저장된 (날짜, 시장)과 빈 응답으로 기록된 것은 다시 받지 않는다. 실패가 남으면 수집 단계가 실패로 끝나 다음 단계를 실행하지 않는다.

## 점검·재판정 (scripts/research-sector-mom-tilt-v2_1-mm.ts)

- 수집 완료 확인: 대상 (월말, 시장) 중 목록에도 빈 응답 기록에도 없는 것이 있으면 멈춘다.
- 점검(연도별 집계): 월말마다 가격 Parquet에 행이 있는 종목 중 두 시장 어디에도 없는 종목 수·시총 비율, 두 시장 동시 등장 수; stock_beta.market과 가장 최근 월말 목록의 일치율; 직전 등장 월말 KOSDAQ → 이번 월말 KOSPI인 이전 건수와 예시.
- 0단계: e1ab2e6 구현 세부 2와 같은 정의·게이트(연도 평균 미상 시총 비율 5%), 시장 = 신호일 월말 목록 값, 목록에 없으면 미상. 통과하면 이어서 v2.1(e1ab2e6 구현 세부 3~7) 계산.
