"use client";

import { supabase } from "@/lib/supabase";

/**
 * 시세 API는 승인된 사용자만 호출할 수 있으므로, 로그인 세션의 액세스 토큰을
 * Authorization 헤더에 실어 보낸다. 서버는 이 토큰으로 승인 상태를 확인한다.
 */
export async function authFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;

  return fetch(url, {
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
}

/** authFetch로 받아온 JSON을 SWR에서 쓰기 좋게 풀어준다. */
export async function authJsonFetcher<T>(url: string): Promise<T> {
  const res = await authFetch(url);
  const data = await res.json();

  if (!res.ok) {
    throw new Error(data?.error ?? "요청에 실패했습니다.");
  }

  return data as T;
}
