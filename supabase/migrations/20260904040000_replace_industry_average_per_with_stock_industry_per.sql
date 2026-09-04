-- 방법A(업종 평균 PER)를 leave-one-out(자기 자신 제외) 중앙값으로 바꾼다.
-- 2026-09-04 실측(삼성전자): 업종 그룹 '26'의 시총 50.6%(SK하이닉스까지 합치면
-- 91.4%)를 차지하는 대형주라, 그룹 전체(자기 포함) PER 중앙값이 삼성전자 자신의
-- PER과 정확히 일치해버려 "업종과 비교"가 사실상 "자기 자신과 비교"가 되는 문제가
-- 확인됐다. 그룹 단위로 미리 계산한 median_per 하나를 모든 소속 종목이 공유하는
-- 대신, 종목별 PER 원자료를 그대로 저장해 API 라우트가 요청 종목을 표본에서
-- 제외하고 그때그때 중앙값을 계산하게 한다.
drop table if exists public.industry_average_per;

create table public.stock_industry_per (
  stock_code text primary key,
  induty_group text not null,
  per numeric, -- 적자 등으로 PER 산출 불가면 null(중앙값 표본에서 제외)
  computed_at timestamptz not null default now()
);

create index stock_industry_per_group_idx on public.stock_industry_per (induty_group);

alter table public.stock_industry_per enable row level security;
-- 공유 시장데이터: service_role만 읽고 쓴다(select 정책 없음, SKILLS.md 관례).
