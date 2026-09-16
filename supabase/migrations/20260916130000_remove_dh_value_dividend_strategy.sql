-- DH전략(dh_value_dividend)을 실패로 판단해 완전히 제거한다(2026-09-16 사용자 요청).
-- 상장폐지 종목이 스크리닝 유니버스에서 구조적으로 100% 배제되고(getAllStocks가 오늘자
-- 종목마스터만 씀), 백테스트 엔진의 미청산 포지션 버그에도 가장 크게 노출된 전략이라
-- (dh_value_dividend는 최대 보유기간 없이 상태가 몇 년이고 유지될 수 있음) 신뢰할 수
-- 없다고 판단했다.
--
-- 실측 확인(scripts/diagnose-dh-removal-impact.ts, 진단 워크플로 실행 결과):
--   strategies(rule_type='dh_value_dividend'): 5건(계정별 1건씩)
--   screening_results(그 전략들에 딸림): 365건(active 265 / stopped 95 / profited 5)
--   paper_positions.screening_result_id가 그중 일부를 참조: 3건
--   paper_trades.screening_result_id가 그중 일부를 참조: 5건
--
-- paper_positions/paper_trades의 screening_result_id는 ON DELETE 지정이 없는 FK라
-- (20260819010000_create_paper_trading.sql), screening_results를 strategies cascade로
-- 지우면 그대로는 FK 위반으로 삭제 트랜잭션이 실패한다. 이 두 FK를 ON DELETE SET NULL로
-- 바꿔 삭제가 가능하게 한다 — AI 모의투자는 가상자금이고 매매 원장(paper_trades)은
-- append-only라 행 자체를 지우면 안 되므로, 참조만 끊고 행은 보존한다. 부작용: 이
-- screening_results를 참조하던 paper_positions(3건)는 이후 원 신호 추적
-- (scripts/paper-trade.ts의 evaluateExit)이 멈춰 그대로 보유 상태로 남는다 — 사용자
-- 확인 하에 감수하기로 한 부작용이며, 이 마이그레이션에서 포지션을 청산하거나 값을
-- 바꾸지는 않는다.
alter table public.paper_positions drop constraint if exists paper_positions_screening_result_id_fkey;
alter table public.paper_positions add constraint paper_positions_screening_result_id_fkey
  foreign key (screening_result_id) references public.screening_results (id) on delete set null;

alter table public.paper_trades drop constraint if exists paper_trades_screening_result_id_fkey;
alter table public.paper_trades add constraint paper_trades_screening_result_id_fkey
  foreign key (screening_result_id) references public.screening_results (id) on delete set null;

-- strategies -> screening_results는 이미 on delete cascade라(20260817030000_create_screening_results.sql)
-- strategies만 지우면 딸린 screening_results도 함께 지워진다.
delete from public.strategies where rule_type = 'dh_value_dividend';
