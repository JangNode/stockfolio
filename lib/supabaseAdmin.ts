import "server-only";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// RLS를 우회하는 서버 전용 클라이언트. 클라이언트 번들에 절대 포함되면 안 되므로
// service role 키는 NEXT_PUBLIC_ 접두사 없이 서버에서만 읽는다.
export const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});
