# 연구 묶음 2 진행 상황 (이어받기용)

정의: `docs/research/batch2-prereg.md`(첫 시험 전 커밋). 시도 번호 282~285, 상한 4개. 정의·기준은 결과를 보고 바꾸지 않는다. 한 시험이 A~H를 전부 통과하면 그 시험까지만 하고 사후 진단(지연 분해, 삼성전자 의존, 연도별, 구간별) 한 번 후 보고한다. 운영 적용·PR 없음.

실행 방법: GitHub Actions → 워크플로 "벤치마크 참조 구현 재실행 (검증, 영구 보존)"을 연구 브랜치 `claude/ma-v3-portfolio-cap-run`에서 `which=batch2`, `only=repro|r1|r2|r3|r4`로 실행(외부 요청 0). 로그에서 `##### Rn` 이하를 기록한다. 시험마다 결과를 `batch2-prereg.md` 7절에 추가하고 이 파일을 갱신한 뒤 커밋·푸시한다. 4개를 마치면 `batch2-summary.md`를 쓰고 PushNotification으로 알린 뒤 요약을 한 번 보고한다.

## 상태
- 정의 문서·설정(`lib/batch2Config.ts`) 작성·커밋 완료. 스크립트(`scripts/research-batch2.ts`)·워크플로 옵션 `batch2` 구현 전.
- 다음에 할 일: 스크립트·워크플로 구현 → 사전 점검(repro) → R1 → R2 → R3 → R4
