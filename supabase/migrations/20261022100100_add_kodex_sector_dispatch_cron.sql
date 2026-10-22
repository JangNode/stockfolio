-- KODEX 200 + 업종 모멘텀 신호 배치(.github/workflows/kodex-sector-signal.yml) 예약 실행.
-- 신호는 매월 첫 거래일 오전에 전월 마지막 거래일 종가 기준으로 계산하고, 매매는 그날(첫 거래일)
-- 종가다 — 장 마감 전에 신호가 나와야 해서 몇 시간 밀리면 안 되는 작업이라 GitHub schedule 대신
-- pg_cron이 workflow_dispatch를 직접 부른다(SKILLS.md "배치 스케줄링 방식 선택"). 평일 아침마다 부르고,
-- "오늘이 그 달 첫 거래일인지"는 작업 안에서 krx_trading_calendar로 판단해 아니면 바로 끝낸다.
-- (전 거래일 KRX 일별매매정보 조회는 2026-10-22 12:24 KST 진단에서 확인 — 08:10 시점은 미확인이라,
--  응답이 비거나 행이 적으면 저장하지 않고 오류를 남긴다.)
-- PAT는 기존 잡과 같은 Vault 시크릿(GITHUB_ACTIONS_PAT)을 쓴다.
create or replace function public.trigger_kodex_sector_signal_dispatch()
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
    raise warning 'GITHUB_ACTIONS_PAT 시크릿이 없어 KODEX 업종 모멘텀 신호 워크플로 트리거를 건너뜁니다.';
    return;
  end if;

  perform net.http_post(
    url := 'https://api.github.com/repos/JangNode/stockfolio/actions/workflows/kodex-sector-signal.yml/dispatches',
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

revoke execute on function public.trigger_kodex_sector_signal_dispatch() from public, anon, authenticated;

-- 평일(월~금) 한국시간(KST) 08:10 = 전날 UTC 23:10(일~목).
select cron.schedule(
  'trigger-kodex-sector-signal',
  '10 23 * * 0-4',
  $$select public.trigger_kodex_sector_signal_dispatch();$$
);
