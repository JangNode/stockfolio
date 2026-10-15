-- [임시 점검 — 읽기 전용] 재무 데이터 2010~ 확보 가능성 점검 항목 1. 집계/크기 조회만 한다.
SET default_transaction_read_only = on;
\echo '== DB 전체 크기'
select pg_size_pretty(pg_database_size(current_database())) as db_size, pg_database_size(current_database()) as db_bytes, round(pg_database_size(current_database()) / 1048576.0 / 500 * 100, 1) as pct_of_500mb;
\echo '== 가장 큰 테이블 상위 5개 (public)'
select relname, pg_size_pretty(pg_total_relation_size(relid)) as total_size, pg_total_relation_size(relid) as total_bytes, pg_size_pretty(pg_relation_size(relid)) as data_size, pg_size_pretty(pg_indexes_size(relid)) as index_size, n_live_tup as approx_rows from pg_stat_user_tables where schemaname = 'public' order by pg_total_relation_size(relid) desc limit 5;
\echo '== stock_annual_fundamentals 전체'
select count(*) as rows, count(distinct stock_code) as stocks, min(fiscal_year) as min_fy, max(fiscal_year) as max_fy, min(rcept_date) as min_rcept, max(rcept_date) as max_rcept from stock_annual_fundamentals;
\echo '== stock_annual_fundamentals 회계연도별'
select fiscal_year, count(*) as rows, count(distinct stock_code) as stocks, min(rcept_date) as min_rcept, max(rcept_date) as max_rcept from stock_annual_fundamentals group by fiscal_year order by fiscal_year;
\echo '== stock_dividend_history 전체'
select count(*) as rows, count(distinct stock_code) as stocks, min(record_date) as min_record, max(record_date) as max_record, count(*) filter (where pay_date is null) as pay_date_null from stock_dividend_history;
\echo '== stock_dividend_history 연도별(record_date 연도)'
select extract(year from record_date)::int as year, count(*) as rows, count(distinct stock_code) as stocks from stock_dividend_history group by 1 order by 1;
\echo '== 재무/배당 테이블 크기, 행당 바이트'
select relname, pg_size_pretty(pg_total_relation_size(relid)) as total_size, pg_total_relation_size(relid) as total_bytes, n_live_tup as approx_rows, round(pg_total_relation_size(relid)::numeric / greatest(n_live_tup, 1), 1) as bytes_per_row from pg_stat_user_tables where relname in ('stock_annual_fundamentals', 'stock_dividend_history', 'dart_corp_codes');
\echo '== Storage 버킷별 크기 (참고)'
select bucket_id, count(*) as objects, pg_size_pretty(sum((metadata->>'size')::bigint)) as total_size, sum((metadata->>'size')::bigint) as total_bytes from storage.objects group by bucket_id order by 4 desc;
