-- FOMC/한국은행 관련 뉴스(연준 통화정책 보도자료·연설/증언, 한국은행 통화정책
-- 보도자료·총재 연설)를 공식 RSS에서 20분 간격으로 수집해 목록으로만 보여준다
-- (수집 + 표시까지만 — 매파/비둘기파 같은 해석은 이번에 하지 않고 나중에 별도로
-- 판단한다). 화면에는 제목/출처/시각/원문 링크만 쓰므로 본문(description)은
-- 저장하지 않는다.
create table public.central_bank_news (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('FED', 'BOK')),
  feed_key text not null,
  title text not null,
  link text not null unique,
  published_at timestamptz not null,
  fetched_at timestamptz not null default now()
);

create index central_bank_news_published_at_idx on public.central_bank_news (published_at desc);

-- us_fed_funds_rate 등 다른 시장 데이터 테이블과 동일하게 select 정책을 추가하지
-- 않는다 — service_role(서버 API 라우트/배치)만 읽고 쓰며, 클라이언트는 항상
-- Next.js API 라우트를 거친다.
alter table public.central_bank_news enable row level security;

-- 뉴스 수집은 "실시간에 가깝게(15~30분 간격)"가 목적이라, GitHub Actions의
-- schedule 트리거 지연(부하 시 몇 시간씩 밀릴 수 있음, 공식 문서에 명시된 동작)이
-- 그대로 목적을 해친다 — 그래서 다른 정시성이 실제로 중요한 배치(스크리닝, 금리
-- 발표 backoff)와 같은 이유로 pg_cron이 workflow_dispatch를 직접 호출한다
-- (20260830120000에서 정리한 "정시성 불필요 = GH 네이티브 schedule" 기준과는
-- 다른 케이스).
create or replace function public.trigger_central_bank_news_dispatch()
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
    raise warning 'GITHUB_ACTIONS_PAT 시크릿이 없어 중앙은행 뉴스 수집 워크플로 트리거를 건너뜁니다.';
    return;
  end if;

  perform net.http_post(
    url := 'https://api.github.com/repos/JangNode/stockfolio/actions/workflows/sync-central-bank-news.yml/dispatches',
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

revoke execute on function public.trigger_central_bank_news_dispatch() from public, anon, authenticated;

-- 20분 간격(매시 0/20/40분).
select cron.schedule(
  'trigger-central-bank-news-sync',
  '*/20 * * * *',
  $$select public.trigger_central_bank_news_dispatch();$$
);
