-- strategies/screening_results의 RLS 정책엔 승인 상태(is_approved()) 체크가 빠져 있었다.
-- watchlist(20260818000000_create_profiles_approval.sql)엔 이미 반영돼 있는데 그때
-- strategies/screening_results는 손대지 않아 누락됐다 — 화면은 로그인+승인 미들웨어
-- (lib/requireApproved.ts)로 막혀 있어도, anon 키로 직접 조회/조작하면 승인 대기 중인
-- 계정도 접근 가능한 구멍이었다. public.is_approved()는 profiles 마이그레이션에서 이미
-- 만들어둔 헬퍼(security definer, RLS 재귀 회피)라 그대로 재사용한다.

drop policy if exists "strategies_select_own" on public.strategies;
create policy "strategies_select_own"
  on public.strategies
  for select
  to authenticated
  using ((select auth.uid()) = user_id and public.is_approved());

drop policy if exists "strategies_insert_own" on public.strategies;
create policy "strategies_insert_own"
  on public.strategies
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id and public.is_approved());

drop policy if exists "strategies_delete_own" on public.strategies;
create policy "strategies_delete_own"
  on public.strategies
  for delete
  to authenticated
  using ((select auth.uid()) = user_id and public.is_approved());

drop policy if exists "screening_results_select_own" on public.screening_results;
create policy "screening_results_select_own"
  on public.screening_results
  for select
  to authenticated
  using (
    public.is_approved()
    and exists (
      select 1 from public.strategies
      where strategies.id = screening_results.strategy_id
        and strategies.user_id = (select auth.uid())
    )
  );
