-- 스크리닝 매칭 종목의 신호 품질 점수(0~100, 정수). 배치 스크립트가 신규 매칭 시점에
-- 한 번만 계산해서 저장한다(추적 갱신 시 다시 계산하지 않음 — signal_price와 같은 성격).
-- 이 컬럼 추가 이전에 저장된 기존 행은 score가 null이며, 배치가 재계산해주지 않는다.
alter table public.screening_results
  add column if not exists score integer check (score is null or (score between 0 and 100));
