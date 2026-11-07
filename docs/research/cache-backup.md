# 연구 캐시 백업·복원 (고정 스냅샷 등) — 사용자 승인 2026-11-07

**목적**: Actions 캐시는 7일 동안 쓰이지 않으면 삭제된다. 고정 스냅샷(`parquet-snapshot-20261026`)은 Storage의 가격 파일이 매일 갱신·정정되어 **같은 바이트로 다시 만들 수 없으므로** 백업 아티팩트(보관 90일)를 둔다. 백업은 **캐시 적중 경로**로 읽어 만들기 때문에 Supabase Storage 읽기 0, 외부 요청 0, 연구 DB 쓰기 0, DART 0이다.

## 1. 저장소 아티팩트 한도 확인 (2026-11-07, 백업 전)
- 저장소 `JangNode/stockfolio`는 **public**이다(API `private: false`).
- 현재 살아 있는 아티팩트 **10개, 합계 25.68 MiB**(가장 큰 것: `research-capr-files-*` 4.62 MiB ×2, `research-alloc-files-*` 4.59 MiB ×2, `research-flow-subset-20261028` 3.58 MiB, `research-scan4a-inputs-20261105` 3.50 MiB). 만료된 항목 0개.
- 백업 대상 원본 합계는 약 232~236 MiB(고정 스냅샷 약 230.9 MiB + 소형 4개). 아티팩트로 올리면 압축(zip, Parquet은 거의 줄지 않음)을 거쳐 비슷한 크기이므로 **백업 뒤 합계는 약 260 MiB 안팎**이다. 워크플로 안에 "백업 대상 400 MiB 초과 시 중단" 점검을 넣었다.
- **계정 단위 아티팩트·캐시 한도와 사용량은 이 샌드박스에서 확인할 수 없다**(GitHub 결제·캐시 사용량 API 경로가 프록시에서 막혀 있음). GitHub 문서 기준으로 public 저장소의 Actions 사용은 저장소 요금제 한도(private 저장소 기준 500 MB 등)에 잡히지 않고, 저장소당 캐시 한도는 10 GB다. 한도 때문에 업로드가 실패하면 **기존 아티팩트를 삭제하지 않고** 실패를 그대로 보고한다(삭제는 사용자 승인 뒤에만).

## 2. 백업 대상과 아티팩트 이름
| 캐시(키) | 복원 경로 | 백업 아티팩트 이름 | 비고 |
|---|---|---|---|
| `parquet-snapshot-20261026` | `.parquet-cache` | `research-backup-parquet-snapshot-20261026` | 가격 Parquet 17개(2010~2026) + 메타·매니페스트(`snapshot.json`) |
| `research-aux-069500-20261026` | `.research-aux` | `research-backup-aux-069500-20261026` | 069500 원주가 보조 파일 |
| `research-alloc-returns-40627267099` | `.alloc-returns` | `research-backup-alloc-returns-40627267099` | LV1 등 일별 순수익(DS6 재현 대조용). 캐시가 없으면 기존 아티팩트 `research-alloc-files-40627267099`에서 보충 |
| `research-vkospi-inputs-20261105` | `.vkospi-inputs` | `research-backup-vkospi-inputs-20261105` | VKOSPI 정리본. 캐시가 없으면 기존 아티팩트 `research-vkospi-inputs-20261105`에서 보충 |
| `research-flow-subset-20261028` | `.research-flow` | `research-backup-flow-subset-20261028` | 외국인 순매수 부분집합(5-A FMD용, **요청 목록에 없던 추가 항목**, 3.6 MiB). 캐시가 없으면 기존 아티팩트 `research-flow-subset-20261028`(2026-11-27 만료)에서 보충 |
각 아티팩트 안에 `SHA256SUMS`(모든 파일의 SHA-256, `sha256sum -c` 형식)가 들어 있고, 실행 로그에 같은 목록과 폴더별 합계가 출력된다. 업로드 결과의 `artifact-digest`(zip 다이제스트)도 로그에 남는다.

## 3. 백업 실행 (`which=bkpack`)
- 워크플로 `diagnose-benchmark-reference-implementation.yml`, `which=bkpack`, `only` 무시. 순서: 캐시 5개 복원(고정 스냅샷·보조 파일은 없으면 중단) → SHA256SUMS 생성·합계 점검 → 아티팩트 5개 업로드(보관 90일) → 요약.
- 실행 시점: 2026-11-10 10:17 KST 예약된 `ds12 only=repro`가 **성공(캐시 적중)한 직후**(예약 작업이 이어서 실행). 

## 4. 복원 방법 (캐시가 없을 때 같은 바이트로) — `which=bkrestore` (코드·문서만 준비, 사용자 지시 전 실행 금지)
1. 워크플로 `which=bkrestore`를 연구 브랜치에서 한 번 실행한다(`only` 무시).
2. 각 키를 `lookup-only`로 조회해 캐시가 **없는 항목만** 복원한다(다운로드 없음). 있으면 건너뜀.
3. 없는 항목마다 같은 이름의 백업 아티팩트(가장 최근 것)를 `gh api`로 내려받아 압축을 풀고 `sha256sum -c SHA256SUMS`로 모든 파일을 검증한다. 하나라도 어긋나면 그 단계가 실패하고 캐시를 저장하지 않는다.
4. 검증을 통과하면 `SHA256SUMS`를 지우고(원래 캐시에는 없던 파일) **원래 키로 `actions/cache/save`** 한다. 이후 모든 연구 워크플로가 평소처럼 캐시 적중으로 실행된다.
5. 복원 뒤 `ds12 only=repro`(DS6 재현 11.70 / 39.15, LV1 캐시 대조)로 기준이 같은지 한 번 확인한다.
- 아티팩트도 만료(90일 → 2027-02-08경)되었거나 한도 때문에 없으면 복원할 수 없다. 이 경우 스냅샷을 Storage에서 새로 만들면 고정 스냅샷과 같은 바이트가 아니므로 **사용자 승인 뒤에만** 한다(수집 계획서 11.3절).
- 부분 복원이 필요하면(예: 보조 파일만) 같은 워크플로를 다시 실행하면 캐시가 있는 항목은 건너뛴다.

## 5. 캐시 유지 실행(주간)
- 11-10(화) 10:17 KST `ds12 only=repro` + 이어서 백업, 이후 화요일 **11-17, 11-24, 12-01, 12-08 10:00 KST**에 `ds12 only=repro`(호출 0, 읽기 0.21 MiB). 지난 5일 안에 같은 목적의 성공한 실행이 있으면 건너뛴다.
- 금요일 DS6 포워드 실행은 사용자가 요청할 때 한다.

## 6. 실행 기록
(2026-11-10 이후 추기: 아티팩트 이름·압축 후 용량·`artifact-digest`·SHA256SUMS 요약)
