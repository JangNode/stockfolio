-- [디스포저블 진단 SQL] hot table(stock_daily_prices_recent) 재시딩 전 DB 용량 실측.
-- 읽기 전용(세션을 read-only로 강제해 이중으로 안전장치를 둔다). 확인 끝나면 이
-- 파일과 대응 워크플로를 정리 PR로 제거한다.

SET default_transaction_read_only = on;

\echo '=== 전체 DB 크기 ==='
SELECT
  pg_size_pretty(pg_database_size(current_database())) AS pretty,
  pg_database_size(current_database()) AS bytes;

\echo ''
\echo '=== 테이블별 크기 상위 10개 (데이터/인덱스 분리) ==='
SELECT
  schemaname,
  relname,
  n_live_tup AS row_estimate,
  pg_size_pretty(pg_table_size(relid)) AS data_size,
  pg_table_size(relid) AS data_bytes,
  pg_size_pretty(pg_indexes_size(relid)) AS index_size,
  pg_indexes_size(relid) AS index_bytes,
  pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
  pg_total_relation_size(relid) AS total_bytes
FROM pg_stat_user_tables
ORDER BY pg_total_relation_size(relid) DESC
LIMIT 10;

\echo ''
\echo '=== stock_daily_prices_recent 상세 ==='
SELECT
  count(*) AS exact_row_count,
  min(trade_date) AS earliest_date,
  max(trade_date) AS latest_date,
  count(DISTINCT stock_code) AS distinct_stock_codes
FROM stock_daily_prices_recent;

\echo ''
\echo '=== stock_daily_prices_recent 크기 / 행당 평균 바이트 ==='
SELECT
  pg_size_pretty(pg_table_size('stock_daily_prices_recent')) AS data_size,
  pg_table_size('stock_daily_prices_recent') AS data_bytes,
  pg_size_pretty(pg_indexes_size('stock_daily_prices_recent')) AS index_size,
  pg_indexes_size('stock_daily_prices_recent') AS index_bytes,
  pg_size_pretty(pg_total_relation_size('stock_daily_prices_recent')) AS total_size,
  pg_total_relation_size('stock_daily_prices_recent') AS total_bytes,
  (SELECT count(*) FROM stock_daily_prices_recent) AS row_count,
  round(pg_total_relation_size('stock_daily_prices_recent')::numeric / GREATEST((SELECT count(*) FROM stock_daily_prices_recent), 1), 1) AS avg_bytes_per_row_total,
  round(pg_table_size('stock_daily_prices_recent')::numeric / GREATEST((SELECT count(*) FROM stock_daily_prices_recent), 1), 1) AS avg_bytes_per_row_data_only;

\echo ''
\echo '=== stock_daily_prices_recent 월별 행 수(최근 30개월, 롤링 삭제가 실제로 도는지 확인용) ==='
SELECT to_char(trade_date, 'YYYY-MM') AS month, count(*) AS rows
FROM stock_daily_prices_recent
GROUP BY 1
ORDER BY 1;
