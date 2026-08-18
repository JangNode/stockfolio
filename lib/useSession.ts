"use client";

import useSWR from "swr";
import { supabase } from "@/lib/supabase";
import { useUser } from "@/lib/useUser";

export type ProfileStatus = "pending" | "approved" | "rejected";

export interface Profile {
  user_id: string;
  email: string;
  status: ProfileStatus;
  is_admin: boolean;
  created_at: string;
  approved_at: string | null;
}

export const PROFILE_COLUMNS =
  "user_id, email, status, is_admin, created_at, approved_at";

/**
 * useUser(로그인 여부)에 profiles의 승인 상태를 얹어 돌려준다. 가입 직후 트리거가
 * 만든 프로필을 아직 못 읽는 등 프로필이 없는 경우는 pending과 동일하게 취급한다.
 *
 * 프로필 조회가 실패했을 때는 status를 그대로 믿으면 안 된다. 조회 실패와 실제
 * 미승인은 다른 상황인데 둘 다 "승인 대기 중"으로 보이면 원인을 찾기 어려우므로,
 * profileError를 따로 노출해 화면에서 구분해 보여줄 수 있게 한다.
 */
export function useSession() {
  const { user, loading: userLoading } = useUser();

  const {
    data: profile,
    error: profileError,
    isLoading: profileLoading,
    mutate: mutateProfile,
  } = useSWR(
    user ? ["profile", user.id] : null,
    async ([, userId]: [string, string]) => {
      const { data, error } = await supabase
        .from("profiles")
        .select(PROFILE_COLUMNS)
        .eq("user_id", userId)
        .maybeSingle();

      if (error) throw error;
      return (data as Profile | null) ?? null;
    }
  );

  const status: ProfileStatus = profile?.status ?? "pending";

  return {
    user,
    profile: profile ?? null,
    status,
    profileError: profileError as Error | undefined,
    isApproved: !!user && status === "approved",
    isAdmin: !!user && status === "approved" && !!profile?.is_admin,
    loading: userLoading || (!!user && profileLoading),
    mutateProfile,
  };
}
