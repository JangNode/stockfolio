-- 액면분할·병합 방어: 확정된 조정계수 이벤트 없이 일간 가격제한폭을 넘는 변동이 감지된 추적 행을 손절·익절·
-- 성과 집계에서 제외하기 위한 상태. price_unavailable과 같은 패턴이며, 이벤트가 확정되면 배치가 자동으로
-- active로 되돌린다. 기존 행의 값은 바꾸지 않고 허용 상태 목록만 넓힌다.
alter table public.screening_results
  drop constraint if exists screening_results_status_check;

alter table public.screening_results
  add constraint screening_results_status_check
  check (status in ('active', 'stopped', 'profited', 'price_unavailable', 'price_anomaly'));
