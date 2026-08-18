"use client";

import { useEffect, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";

/**
 * 로그인한 사용자를 읽는다.
 *
 * 초기값을 getUser()로 읽으면 안 된다. getUser()는 저장된 세션이 있어도 매번
 * /auth/v1/user로 네트워크 요청을 보내고, 그 요청이 실패하면 error와 함께
 * user: null을 돌려준다. 반면 onAuthStateChange의 INITIAL_SESSION은 저장소만
 * 읽어 먼저 도착하므로, 뒤늦게 도착한 getUser()의 null이 이미 세팅된 정상
 * 사용자를 덮어써 "로그인했는데도 로그인이 필요합니다"가 뜬다.
 *
 * 그래서 로컬 저장소만 보는 getSession()을 쓴다. 두 경로가 같은 세션을 읽으므로
 * 서로 모순되는 값을 쓰지 않는다. getSession()의 값은 서버에서 검증된 것이
 * 아니지만, 이 값은 화면 분기에만 쓰고 실제 접근 통제는 API 라우트의 토큰 검증
 * (lib/requireApproved.ts)과 RLS가 담당하므로 문제되지 않는다.
 */
export function useUser() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setUser(data.session?.user ?? null);
      setLoading(false);
    });

    const { data: subscription } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        if (!active) return;
        setUser(session?.user ?? null);
        setLoading(false);
      }
    );

    return () => {
      active = false;
      subscription.subscription.unsubscribe();
    };
  }, []);

  return { user, loading };
}
