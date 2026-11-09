# 아티팩트 정리 (저장소 공개 상태 대응) — 사용자 지시 2026-11-10

저장소 `JangNode/stockfolio`는 공개이고 Actions 아티팩트는 GitHub 로그인한 누구나 내려받을 수 있다고 가정한다. KRX·KIS 약관상 받은 데이터를 제3자에게 제공할 수 없다는 조항이 있다는 2차 자료가 있어(`docs/research/` 이전 보고 참고, 원문은 확인 못 함), KRX·KIS·DART 유래 데이터 파일은 공개 아티팩트로 두지 않는다.

## 1. 정리 전 목록 (10개, 25.68 MiB, 2026-11-10 조회)

| 이름 | 용량 | 내용 종류 | 아티팩트를 쓰는 워크플로 복원 경로 | 조치 |
|---|---|---|---|---|
| `research-flow-subset-20261028` | 3.58 MiB | **KIS** 종목별 외국인 순매수금액 3열(종목코드, 일자, 금액) | `scan5s`(5-A) 캐시 `research-flow-subset-20261028`이 없을 때 대체 복원, `bkpack`의 캐시 밖 보충. 정상 경로는 같은 이름의 Actions 캐시(`vgt`·`scan5s`) | **삭제함** |
| `research-scan4a-inputs-20261105` | 3.50 MiB | **KIS** 종목별 체결강도(420종목, 2011~2016)·프로그램매매 시장 단위 정리본 | 아티팩트로 복원하는 워크플로 단계 없음(`scan4as`는 캐시만 사용). 원천은 Supabase Storage 정리본 | **삭제함** |
| `research-vkospi-inputs-20261105` | 0.11 MiB | **KRX** 코스피200 변동성지수 일별 정리본 Parquet | `bkpack`의 캐시 밖 보충만. `vkscan`·`vkconf`·`ds12`·`batch3`는 Actions 캐시 `research-vkospi-inputs-20261105`를 쓴다. 원천은 Storage `research/vkospi` | **삭제함** |
| `research-alloc-files-40627267099` | 4.59 MiB | 일별 순수익 JSON(파생 결과) + `.research-subset`(**DART** 영업이익 열·공시 목록 + **KRX** 월말 시장 구분 목록) | `bkpack`의 캐시 밖 보충만(캐시 `research-alloc-returns-40627267099`가 정상 경로) | **보류(DART 포함, 사용자 확인 대기)** |
| `research-alloc-files-40627558143` | 4.59 MiB | 위와 같음 | 복원 경로 없음 | **보류(DART 포함)** |
| `research-capr-files-41359098160` | 4.62 MiB | PE4 분해·일별 순수익 JSON(파생) + `.research-subset`(DART·KRX 월말 목록) | 복원 경로 없음 | **보류(DART 포함)** |
| `research-capr-files-41359433744` | 4.62 MiB | 위와 같음 | 복원 경로 없음 | **보류(DART 포함)** |
| `strategy-daily-returns` | 0.08 MiB | 앱 전략 백테스트 요약용 일별 수익 계열(2026-09-24 진단 산출물, 파생 결과로 판단) | 복원 경로 없음 | 유지(데이터 아님으로 판단, 내용은 blob 도메인이 막혀 직접 확인 못 함) |
| `correction-backup` | 약 1.3 KB | 가격 정정 백업 소량(2026-10-04 산출물, 내용 직접 확인 못 함) | 복원 경로 없음 | 유지 |
| `ds6-forward-log` | 약 0.5 KB | DS6 포워드 일별 결과 로그(`ds6-forward-log.csv`, 069500 종가 원주가 열 포함) | `ds6fwd`의 커밋 작업이 받는다(DS6 포워드 도구, 건드리지 않음) | 유지(결과 로그) |

`bkpack`·`bkrestore` 단계는 이 목록의 `research-alloc-files-40627267099`·`research-flow-subset-20261028`·`research-vkospi-inputs-20261105`를 보충 경로로만 썼고, 워크플로에서 제거했다(아래 3절).

## 2. 삭제 기록 (2026-11-10, GitHub REST `DELETE .../actions/artifacts/{id}` 응답 204)

| 아티팩트 | ID | 용량 |
|---|---|---|
| `research-vkospi-inputs-20261105` | 13412679020 | 0.11 MiB |
| `research-flow-subset-20261028` | 12781433078 | 3.58 MiB |
| `research-scan4a-inputs-20261105` | 13405021478 | 3.50 MiB |
| 합계 | | 약 7.19 MiB |

삭제 후 살아 있는 아티팩트는 7개, 합계 18.49 MiB(전부 위 표의 보류·유지 항목). 삭제는 KRX·KIS 데이터 3개만 했다. Actions 캐시와 Supabase Storage 정리본은 건드리지 않았다.

## 3. 워크플로 수정 (`.github/workflows/diagnose-benchmark-reference-implementation.yml`)

- 데이터를 아티팩트로 올리는 단계 11개 제거: 부분집합(PE4·PEAD 입력), PEAD 잠정실적 파싱 결과, 수급 부분집합, 구성요소·PE4 분해 일별 순수익, 스캔 4-A·VKOSPI·스캔 5(외국계 창구·대차)·신용잔고 정리본. 로그·요약·결과 표만 아티팩트로 허용한다. 남은 것은 `ds6-forward-log`(DS6 포워드 결과 로그) 한 곳뿐이다.
- `scan5s`의 아티팩트 복원 단계를 제거하고, 입력 캐시가 없으면 오류로 중단하고 보고하는 단계로 바꿨다(복원 시도 없음).
- `bkpack`(캐시 백업 올리기)·`bkrestore`(백업 아티팩트에서 복원) 단계 24개 제거. 코드·문서에는 "비공개 저장소에서만 사용" 메모를 남겼다(`docs/research/cache-backup.md` 머리말과 워크플로 주석).
- 영향 확인: 이 저장소가 비공개로 바뀌면 필요할 때 `docs/research/cache-backup.md`의 방법으로 되살린다(커밋 `96df1d4` 참고).

## 4. 커밋 파일 `docs/research/ds6-forward-log.csv` (삭제 안 함, 보고만)

데이터 6행(2026-10-27, 10-28, 10-29, 10-30, 11-02, 11-03) + 머리글. 열: 날짜, DS6·069500 일수익률·누적·낙폭, **069500 종가 원주가(`b069500_close_raw`)**, 종가 출처(`krx`), 코어 보유(005930·000660 비중), 월말 시장 구분 기준일. KRX 원본 데이터로 볼 수 있는 값은 069500 일별 종가 6개뿐이고 나머지는 계산 결과다.
