"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import type { User } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";

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
 * 로그인한 사용자와 그 승인 상태(profiles)를 함께 읽는다. 가입 직후 트리거가
 * 만든 프로필을 아직 못 읽는 등 프로필이 없는 경우는 pending과 동일하게 취급한다.
 */
export function useSession() {
  const [user, setUser] = useState<User | null>(null);
  const [userLoading, setUserLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setUser(data.user);
      setUserLoading(false);
    });

    const { data: subscription } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        setUser(session?.user ?? null);
        setUserLoading(false);
      }
    );

    return () => subscription.subscription.unsubscribe();
  }, []);

  const {
    data: profile,
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
    isApproved: !!user && status === "approved",
    isAdmin: !!user && status === "approved" && !!profile?.is_admin,
    loading: userLoading || (!!user && profileLoading),
    mutateProfile,
  };
}
