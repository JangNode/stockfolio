-- FOMC/금통위 일정을 이제 매주 자동 수집하므로(scripts/sync-rate-schedules.ts),
-- 회의 날짜가 확정될 때마다 20260828090000처럼 마이그레이션을 새로 추가하는 대신
-- 이 함수를 통해 그때그때 해당 날짜의 발표 집중 확인 cron(offsets
-- 0,5,15,30,60,120)을 등록한다. pg_cron의 cron.schedule(job_name, ...)은 같은
-- job_name으로 다시 호출하면 기존 잡을 그대로 갱신하므로(중복 생성되지 않음),
-- 매주 재실행해도 안전하다.
--
-- pg_cron은 연도 필드가 없어 "매년 같은 월/일에 반복"되는 한계가 있다 —
-- 20260828090000의 정적 항목들도 이미 같은 특성이었고, 실제로 발동해도
-- trigger_rate_check_dispatch가 그냥 변화 없음으로 끝나는 멱등 동작이라 해롭지
-- 않다(20260828090000의 2026년 정적 항목은 과거 기록으로 그대로 둔다).
create or replace function public.register_meeting_backoff_cron(p_job_name text, p_cron_expr text, p_market text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform cron.schedule(
    p_job_name,
    p_cron_expr,
    format($f$select public.trigger_rate_check_dispatch(%L, '0,5,15,30,60,120');$f$, p_market)
  );
end;
$$;

revoke execute on function public.register_meeting_backoff_cron(text, text, text) from public, anon, authenticated;

-- 일정 동기화 배치도 다른 배치와 같은 이유로 GitHub Actions schedule 대신
-- pg_cron이 workflow_dispatch를 직접 호출한다(.github/workflows/sync-rate-schedules.yml).
create or replace function public.trigger_schedule_sync_dispatch()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token text;
begin
  select decrypted_secret into v_token
  from vault.decrypted_secrets
  where name = 'GITHUB_ACTIONS_PAT'
  limit 1;

  if v_token is null then
    raise warning 'GITHUB_ACTIONS_PAT 시크릿이 없어 일정 동기화 워크플로 트리거를 건너뜁니다.';
    return;
  end if;

  perform net.http_post(
    url := 'https://api.github.com/repos/JangNode/stockfolio/actions/workflows/sync-rate-schedules.yml/dispatches',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_token,
      'Accept', 'application/vnd.github+json',
      'Content-Type', 'application/json',
      'X-GitHub-Api-Version', '2022-11-28'
    ),
    body := jsonb_build_object('ref', 'main')
  );
end;
$$;

revoke execute on function public.trigger_schedule_sync_dispatch() from public, anon, authenticated;

-- 매주 월요일 한국시간(KST) 06:00 = UTC 일요일 21:00.
select cron.schedule(
  'trigger-rate-schedule-sync',
  '0 21 * * 0',
  $$select public.trigger_schedule_sync_dispatch();$$
);
