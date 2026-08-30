-- 20260830110000에서 일정 동기화 배치(scripts/sync-rate-schedules.ts)도 다른
-- 배치처럼 pg_cron이 workflow_dispatch를 호출하도록 연결했는데, 재검토 결과 과잉
-- 적용이었다. pg_cron 도입 이유는 "GitHub Actions schedule이 부하 시 몇 시간씩
-- 밀리는 문제"를 피하기 위함이고, 이건 스크리닝(장 시작 시각에 맞춰야 함)이나
-- 금리 발표 backoff(register_meeting_backoff_cron, 발표 순간을 놓치면 재시도
-- 의미가 없음)처럼 정시성이 실제로 결과에 영향을 주는 작업에만 값어치가 있다.
-- 일정 스크래핑은 연 1~2회만 새 회의가 추가되는 정적 데이터를 최신 상태로 맞춰
-- 두는 배치라 몇 시간 밀려도 다음 주 실행에서 자동으로 따라잡으므로(스크립트가
-- 매번 전체 재수집·비교하는 멱등 동작), 정시성이 필요 없다 — GITHUB_ACTIONS_PAT
-- 시크릿을 경유하는 불필요한 실패 지점만 늘어날 뿐이라 제거한다.
--
-- .github/workflows/sync-rate-schedules.yml을 GitHub Actions 네이티브 schedule
-- 트리거(매주 월요일 KST 06:00)로 되돌렸으니, 이 pg_cron 잡과 그 전용 dispatch
-- 함수를 제거한다. register_meeting_backoff_cron(발표 집중 확인 cron 동적 등록,
-- 정시성 필요)은 그대로 유지한다.
-- cron.unschedule(job_name)이 잡을 못 찾으면 예외를 던지는 pg_cron 버전도 있어
-- (이미 지워졌거나 애초에 등록 안 됐을 가능성 포함), 마이그레이션 적용 자체가
-- 막히지 않도록 감싼다.
do $$
begin
  perform cron.unschedule('trigger-rate-schedule-sync');
exception when others then
  raise notice 'trigger-rate-schedule-sync cron 잡 제거 중 예외(이미 없었을 수 있음) — 무시: %', sqlerrm;
end;
$$;

drop function if exists public.trigger_schedule_sync_dispatch();
