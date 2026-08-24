-- DB 용량 조사(2026-08-24)에서 확인한 중복 인덱스 2개를 제거한다. 둘 다 같은 테이블에
-- 이미 있는 unique 제약이 자동으로 만든 인덱스와 컬럼 구성이 겹쳐서, 별도 성능 이점
-- 없이 용량과 write 비용만 두 배로 드는 상태였다(실측: supabase inspect db index-stats
-- 기준 두 인덱스 모두 활성 사용 중이었지만, unique 인덱스가 동일 조회를 그대로
-- 대신할 수 있어 안전하게 제거 가능).

-- paper_daily_snapshots_portfolio_id_idx (portfolio_id, snapshot_date):
-- unique(portfolio_id, snapshot_date) 제약이 만든 paper_daily_snapshots_portfolio_id_snapshot_date_key
-- 인덱스와 컬럼 구성·순서가 완전히 동일하다. 유니크 제약은 그대로 남아있으므로
-- 이 인덱스만 지워도 데이터 무결성·조회 성능에 영향 없다.
drop index if exists public.paper_daily_snapshots_portfolio_id_idx;

-- paper_positions_portfolio_id_idx (portfolio_id):
-- unique(portfolio_id, stock_code) 제약이 만든 paper_positions_portfolio_id_stock_code_key
-- 인덱스의 선행 컬럼(portfolio_id)과 겹친다. portfolio_id만으로 조회할 때도 이
-- 복합 유니크 인덱스를 그대로 쓸 수 있어 단일 컬럼 인덱스는 불필요하다.
drop index if exists public.paper_positions_portfolio_id_idx;
