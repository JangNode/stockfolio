-- KRX Open API etp/etf_bydd_trd 일별 응답 중 업종 ETF 후보(업종 키워드에 한 번이라도 걸린 코드) + 069500·114260의 전 기간 행(연구용 새 표, 기존 표는 건드리지 않는다).
-- tdd_clsprc는 분배금 미반영 종가, acc_trdval은 거래대금(원). 공유·전역 시장 데이터라 RLS만 켜고 정책은 두지 않는다(service_role 전용).
create table public.etf_krx_daily (
  bas_dd date not null,
  isu_cd text not null,
  isu_nm text,
  tdd_clsprc numeric,
  nav numeric,
  acc_trdval numeric,
  mktcap numeric,
  idx_ind_nm text,
  obj_stkprc_idx numeric,
  primary key (isu_cd, bas_dd)
);

alter table public.etf_krx_daily enable row level security;
