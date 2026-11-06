# 신호 스캔 4회차 진행 상황 (이어받기용)

- 사전등록 확정: `docs/research/signal-scan-3-prereg.md`(커밋 `b7edd74`, 수집 전). 수집 계획: `docs/research/signal-scan-3-collection-plan.md`.
- **4-A 완료(2026-11-05)**: 수집 run 42001466903, 스캔 run 42006496593. 결과: 후보 0행 / 33행(누적 스캔 행 321). 결과 표는 prereg 10절.
- **미실행(승인 대기)**: 4-B = 대차잔고 수집(2015~, 호출당 100행, 약 4,300~10,100회) + 스캔 16행. **11-14 이후** 별도 승인과 별도 사전등록 커밋(대차 구간 2015-04~2019-12 학습)이 필요하다. 신용잔고 정리본 읽기(약 20.6 MiB)도 11-14 이후.
- 확인·보류 구간(2017~) 체결강도 수집은 후보가 없어 필요하지 않다.
- 입력 정리본: Actions 캐시 `research-scan4a-inputs-20261105`(7일 미사용 시 삭제), 아티팩트 `research-scan4a-inputs-20261105`(30일), Storage `research/exec_strength_clean`·`research/program_trade_market_clean`(+원본 `research/exec_strength`·`research/program_trade_market`).
- 시험 번호 285 유지(스캔은 시험이 아님).
- **2026-11-06 갱신**: 4-B(대차) 초안은 `docs/research/signal-scan-5-prereg.md`(스캔 5회차 5-B, 신호·구간 정의 그대로)로 옮겼다. 수집 계획은 `docs/research/signal-scan-5-collection-plan.md`(외국계 창구 5-A + 대차 5-B, 신용잔고 정리본 읽기·DS6 포워드 캐시 판단 포함). 둘 다 계획·초안만이고 승인(11-14 이후) 전에는 수집·호출 없음. **Actions 캐시 만료 위험(고정 스냅샷 등 약 11-12~13): 11-11까지 유지 실행 여부 결정 필요(수집 계획 5절).**
