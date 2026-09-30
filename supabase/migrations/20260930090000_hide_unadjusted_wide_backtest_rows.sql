-- 원자료를 넓힌 직후(2026-09-30 06:27 UTC 배치) 수치는 분할·병합 보정 전 원가 기준이고
-- 유니버스도 아직 사후 선정(시가총액 1조원 이상 이력)이라 화면에 내보내지 않기로
-- 했다(팀장 결정). 행은 삭제하지 않고 data_widen_stage 값만 'wide_unadjusted'로 바꿔
-- 화면 API가 숨기게 한다(다른 컬럼은 건드리지 않는다). 조정계수 적용 후 새 배치 행을
-- 'full'로 올린다.
update public.strategy_backtest_summary
  set data_widen_stage = 'wide_unadjusted'
  where data_widen_stage = 'full';

update public.benchmark_summary
  set data_widen_stage = 'wide_unadjusted'
  where data_widen_stage = 'full';
