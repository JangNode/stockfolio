-- 회원가입 후 관리자 승인을 받아야 서비스를 이용할 수 있게 하는 프로필 테이블.
create table if not exists public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected')),
  is_admin boolean not null default false,
  created_at timestamptz not null default now(),
  approved_at timestamptz
);

create index if not exists profiles_status_idx on public.profiles (status);

-- 가입하면 auth.users에 행이 생기고, 그 트리거로 pending 프로필이 자동 생성된다.
-- auth 스키마는 클라이언트가 직접 쓸 수 없으므로 가입 로직이 아니라 트리거로 처리하며,
-- profiles에는 insert 정책이 없으므로 security definer로 RLS를 우회해 삽입한다.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (user_id, email)
  values (new.id, coalesce(new.email, ''))
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();

-- 이 마이그레이션 이전에 이미 가입해 서비스를 쓰고 있던 계정은 승인된 것으로 본다.
-- (승인 기능을 켜자마자 기존 사용자가 잠기는 것을 막기 위함)
insert into public.profiles (user_id, email, status, created_at, approved_at)
select u.id, coalesce(u.email, ''), 'approved', u.created_at, now()
from auth.users u
on conflict (user_id) do nothing;

-- profiles의 RLS 정책 안에서 다시 profiles를 조회하면 정책이 자기 자신을 재귀 호출한다.
-- security definer 함수로 감싸 RLS를 우회해서 무한 재귀를 피한다.
create or replace function public.is_approved()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.user_id = (select auth.uid())
      and p.status = 'approved'
  );
$$;

-- 관리자는 승인된 계정이어야 한다. 거절/대기 상태에서 관리자 권한만 남는 일을 막는다.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.user_id = (select auth.uid())
      and p.status = 'approved'
      and p.is_admin
  );
$$;

alter table public.profiles enable row level security;

-- 본인 프로필은 누구나 조회할 수 있어야 승인 대기 화면을 띄울 수 있다.
drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
  on public.profiles
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- 관리자는 가입 신청 목록을 봐야 하므로 전체 조회가 가능하다.
drop policy if exists "profiles_select_admin" on public.profiles;
create policy "profiles_select_admin"
  on public.profiles
  for select
  to authenticated
  using (public.is_admin());

-- 수정은 관리자만. insert 정책은 두지 않는다(가입 트리거만 행을 만든다).
drop policy if exists "profiles_update_admin" on public.profiles;
create policy "profiles_update_admin"
  on public.profiles
  for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- 관심종목은 브라우저에서 anon 키로 직접 조회하므로, 화면에서 막는 것만으로는
-- 부족하다. 승인된 사용자만 접근하도록 RLS 정책 자체를 조인다.
drop policy if exists "watchlist_select_own" on public.watchlist;
create policy "watchlist_select_own"
  on public.watchlist
  for select
  to authenticated
  using ((select auth.uid()) = user_id and public.is_approved());

drop policy if exists "watchlist_insert_own" on public.watchlist;
create policy "watchlist_insert_own"
  on public.watchlist
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id and public.is_approved());

drop policy if exists "watchlist_delete_own" on public.watchlist;
create policy "watchlist_delete_own"
  on public.watchlist
  for delete
  to authenticated
  using ((select auth.uid()) = user_id and public.is_approved());
