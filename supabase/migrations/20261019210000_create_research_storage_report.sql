-- 연구용 읽기 전용 크기 보고 함수. DB 전체 크기, investor_flow_stock_pilot 행 수·데이터·인덱스 크기, public 상위 표 크기를 반환한다. 데이터 변경 없음.
-- security definer + service_role 전용(public/anon/authenticated 실행 권한 회수).
create or replace function public.research_storage_report()
returns jsonb
language sql
security definer
set search_path = public, pg_catalog
as $$
  select jsonb_build_object(
    'db_bytes', pg_database_size(current_database()),
    'pilot_rows', (select count(*) from public.investor_flow_stock_pilot),
    'pilot_data_bytes', pg_table_size('public.investor_flow_stock_pilot'),
    'pilot_index_bytes', pg_indexes_size('public.investor_flow_stock_pilot'),
    'pilot_total_bytes', pg_total_relation_size('public.investor_flow_stock_pilot'),
    'top_tables', (
      select coalesce(jsonb_agg(t order by (t->>'total_bytes')::bigint desc), '[]'::jsonb)
      from (
        select jsonb_build_object('table', c.relname, 'total_bytes', pg_total_relation_size(c.oid), 'index_bytes', pg_indexes_size(c.oid)) as t
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'
        order by pg_total_relation_size(c.oid) desc limit 10
      ) s
    )
  );
$$;

revoke execute on function public.research_storage_report() from public, anon, authenticated;
grant execute on function public.research_storage_report() to service_role;
