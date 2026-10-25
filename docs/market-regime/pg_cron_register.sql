-- [등록 금지 상태로 작성만 함 — 사용자 승인 후 Supabase SQL 편집기 등에서 직접 실행]
-- 시장 국면 일일 배치(.github/workflows/market-regime.yml)를 평일 16:40 KST(= 07:40 UTC)에 pg_cron이
-- workflow_dispatch로 직접 호출한다. 정시성 때문에(직전 거래일 자료가 준비된 뒤 곧바로) GitHub Actions
-- 네이티브 schedule 대신 이 방식을 쓴다(SKILLS.md 배치 스케줄링 원칙, 시장 브리핑·스크리닝과 같은 패턴).
-- supabase/migrations 밖에 둔 이유: 마이그레이션 적용 워크플로가 이 파일까지 실행해 예약이 먼저 등록되는 일을 막기 위해서다.
-- GITHUB_ACTIONS_PAT Vault 시크릿은 이미 존재한다(다른 배치가 사용 중) — 새로 만들 시크릿은 없다.
-- 선행 조건: 1) 이 브랜치 병합(워크플로 파일이 main에 있어야 dispatch 가능) 2) market_regime_daily 마이그레이션 적용 3) 이력 백필 완료.
create or replace function public.trigger_market_regime_dispatch()
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
    raise warning 'GITHUB_ACTIONS_PAT 시크릿이 없어 시장 국면 워크플로 트리거를 건너뜁니다.';
    return;
  end if;

  perform net.http_post(
    url := 'https://api.github.com/repos/JangNode/stockfolio/actions/workflows/market-regime.yml/dispatches',
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

revoke execute on function public.trigger_market_regime_dispatch() from public, anon, authenticated;

-- 평일(월~금) 07:40 UTC = 16:40 KST. 휴장일에 돌아도 배치가 직전 거래일이 이미 저장돼 있으면 아무것도 하지 않는다.
select cron.schedule(
  'trigger-market-regime',
  '40 7 * * 1-5',
  $$select public.trigger_market_regime_dispatch();$$
);
