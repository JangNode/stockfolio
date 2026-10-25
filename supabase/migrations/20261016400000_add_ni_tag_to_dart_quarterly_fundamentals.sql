-- dart_quarterly_fundamentals에 순이익 계정 출처 기록 컬럼 추가(컬럼 추가만).
-- ni_tag: 'parent' = ProfitLossAttributableToOwnersOfParent, 'profitloss' = 폴백으로 쓴 ProfitLoss, null = 순이익 계정 없음
-- 또는 폴백 규칙 도입 전(1회차)에 저장된 행. 기존 행의 값은 바꾸지 않는다.
alter table public.dart_quarterly_fundamentals
  add column if not exists ni_tag text check (ni_tag in ('parent', 'profitloss'));
