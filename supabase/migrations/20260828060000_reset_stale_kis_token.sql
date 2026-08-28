-- 레이스 컨디션 수정(20260828050000_add_issuing_lock_to_kis_tokens.sql) 이전에
-- 저장된 토큰은 이미 KIS 쪽에서 무효화됐을 수 있다 — 우리 expires_at 상으로는
-- 아직 안 지났어도, 그 사이 다른 인스턴스가 재발급하면서 이 토큰을 무효화했을
-- 가능성이 있다("기간이 만료된 token입니다" 오류가 수정 배포 이후에도 계속
-- 재현됨). expires_at을 강제로 과거로 돌려 다음 호출이 무조건 새로
-- 발급하게(이제는 잠금이 있으니 안전하게) 만든다.
update public.kis_tokens set expires_at = to_timestamp(0), issuing_until = null where id = 'kis';
