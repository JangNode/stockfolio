# stockFolio 작업 체크리스트

이 프로젝트에서 반복되는 작업 패턴과, 그 과정에서 쌓인 실전 노하우.

## 새 전략 추가

1. point-in-time 데이터만 쓰는지 확인한다(미래 데이터 누수 금지 —
   `RULES.md` 1번). 결산·공시 이후에나 알 수 있는 값을 그 이전 시점 판단에
   섞지 않는다.
2. 기준값·임계치는 `lib/*Config.ts`에 상수로 분리하고, 출처를 주석으로
   남긴다.
3. 백테스트 엔진(`lib/backtest.ts` 등)에 연동한다.
4. 스크리닝 배치(`scripts/screen-*.ts`)에 연동한다.
5. 신규 전략은 보통 오늘자 데이터 기준 즉시 스크리닝이 필요한지 확인한다
   (다음 정기 배치까지 기다리지 않고 바로 결과를 보여줘야 하는 경우가 많음).
6. UI(전략 관리/스크리닝/백테스트 화면)에 반영한다.

## 마이그레이션 작성

- 파일명: `YYYYMMDDHHMMSS_설명.sql`(시각 기준 오름차순 적용).
- **이미 적용된 마이그레이션 파일은 절대 수정하지 않는다** — 되돌리거나
  바꾸고 싶으면 항상 새 마이그레이션을 추가한다(`RULES.md` 5번).
- 공유·전역 시장 데이터 테이블(사용자별로 나뉘지 않는 데이터): RLS
  활성화 + select 정책은 추가하지 않는다(service_role만 읽고 씀). 클라이언트는
  항상 Next.js API 라우트를 거쳐서 읽는다.
- pg_cron이 GitHub Actions를 호출해야 하면 `security definer` 함수 +
  `vault.decrypted_secrets`에서 `GITHUB_ACTIONS_PAT` 조회 + `net.http_post`
  패턴을 따르고, `revoke execute ... from public, anon, authenticated`로
  막는다.
- 적용은 로컬이 아니라 "Apply Supabase Migrations" GitHub Actions 워크플로로
  한다.

## 외부 API·사이트 연동

- 무료 한도부터 조사한다(호출 수 제한, 데이터량 제한).
- 저장이 필요하면 변경점만 저장하는 패턴(`computeChangePoints`류)을 먼저
  검토한다 — 원천 데이터가 매일 갱신돼도 실제 값이 바뀐 시점만 저장하면
  저장량이 크게 줄어든다.
- 샌드박스가 직접 접근하지 못하는 도메인이 있으면(과거 사례:
  `federalreserve.gov`, `bok.or.kr`, `ecos.bok.or.kr`, `fred.stlouisfed.org`
  등), 추측으로 파서를 작성하지 않는다 — 디스포저블 진단 스크립트
  (`scripts/diagnose-*.ts`) + 임시 GitHub Actions 워크플로로 실제 응답
  구조를 먼저 확인한 뒤 진짜 구현을 작성한다. 워크플로는 `workflow_dispatch`만
  등록해도 되지만, **최초 등록 시엔 반드시 `main`에 머지돼 있어야
  `workflow_dispatch` API로 실행할 수 있다**(신규 워크플로 파일은 default
  브랜치에 있어야 GitHub가 인식함). 이후 반복 실행은 feature 브랜치를 ref로
  줘도 된다.
- 스크래핑 파서는 실패 시 조용히 넘어가지 않는다 — 명확한 에러 로그를
  남기고 기존에 저장된 데이터는 그대로 유지한다(덮어쓰기 금지). 파싱 결과가
  상식적인 범위인지 검증하는 로직을 넣는다(예: 연 8회 내외여야 하는 값이
  크게 벗어나면 파싱 실패로 간주).
- 마지막 성공/시도 시각을 별도로 기록해, 오래 갱신되지 않으면 알아챌 수
  있게 한다.

## 배치 스케줄링 방식 선택

- **정시성이 실제로 결과에 영향을 주는 경우**(발표 순간을 놓치면 재시도
  의미가 없는 backoff, 장 시작 시각에 맞춰야 하는 스크리닝 등) →
  Supabase pg_cron이 `workflow_dispatch` API를 직접 호출한다. GitHub Actions
  네이티브 `schedule:` 트리거는 부하 시 몇 시간씩 밀릴 수 있어(공식 문서에
  명시된 동작) 이런 경우엔 못 쓴다.
- **몇 시간 밀려도 무방한 경우**(주 1회 정도의 정적 데이터 갱신 등) →
  GitHub Actions 네이티브 `schedule:` 트리거를 그대로 쓴다. 불필요하게
  pg_cron 잡을 늘리지 않는다 — pg_cron 경유는 `GITHUB_ACTIONS_PAT` 시크릿에
  의존하는 실패 지점을 하나 더 만든다.
- 판단이 애매하면 "이 작업이 몇 시간 늦게 실행돼도 사용자가 실제로 피해를
  보는가?"로 결정한다.

## PR/검증 흐름

1. `main`에서 새 브랜치를 판다.
2. 구현 후 로컬에서 `npx tsc --noEmit`과 `npm run lint`를 돌려 통과를
   확인한다(로컬은 Supabase 환경변수가 없어 `next build`가 무관한 라우트에서
   실패할 수 있다 — 이건 정상이며, 실제 빌드 검증은 CI가 한다).
3. PR을 생성하고 CI(Vercel 프리뷰 배포)가 성공하는지 확인한 뒤 병합한다.
4. 마이그레이션이 있으면 "Apply Supabase Migrations" 워크플로를 실행해
   적용한다.
5. 실데이터 검증이 필요하면(외부 연동, 배치 등) 디스포저블 verify
   스크립트 + 임시 워크플로로 실제 동작을 확인한다.
6. 진단·검증용 임시 스크립트/워크플로는 별도 정리 PR로 제거한다.
7. 장수명 작업 브랜치가 있으면 `git merge origin/main`으로 동기화한다.
