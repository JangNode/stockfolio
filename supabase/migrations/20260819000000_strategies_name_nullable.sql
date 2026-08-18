-- 화면에서 더 이상 이름을 입력받지 않고, Supabase에서 직접 행을 넣을 때도 name을
-- 매번 채워줄 필요가 없도록 not null 제약을 없앤다. 값은 이제 로그 라벨 용도로만 쓰인다.
alter table public.strategies alter column name drop not null;
