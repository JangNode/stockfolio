-- 커스텀 백테스트 결과(매칭 종목/거래 내역 전체)를 담는 비공개 Storage 버킷.
-- custom_backtest_runs 표엔 요약 통계만 남기고, 무거운 원본 결과는 여기 JSON으로
-- 저장한다(DB 용량 최적화 작업의 연장선). service_role(GitHub Actions 워크플로/API
-- 라우트)만 접근하고 클라이언트에 직접 노출하지 않으므로 storage.objects에 별도 RLS
-- 정책을 추가하지 않는다 — service_role은 RLS를 우회하고, public이 아닌 버킷은
-- anon/authenticated 키로는 기본적으로 아무 권한도 없다.
insert into storage.buckets (id, name, public)
values ('custom-backtest-results', 'custom-backtest-results', false)
on conflict (id) do nothing;
