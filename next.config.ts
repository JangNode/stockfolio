import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 서버리스 함수 번들에서 제외할 파일들. 실측 결과 sharp 네이티브 바이너리가 라우트당
  // ~44MB씩 중복 포함되고 있었다(next/image를 이 앱은 쓰지 않는데도 Next.js가 이미지
  // 최적화 기능을 대비해 보수적으로 전부 포함시킨다) — Vercel Functions Storage 초과의
  // 실제 원인. scripts/·supabase/migrations/는 실측상 이미 트레이싱되지 않고 있었지만
  // (어떤 라우트도 import하지 않음) 안전장치로 명시해둔다.
  outputFileTracingExcludes: {
    "*": [
      "node_modules/@img/**",
      "node_modules/sharp/**",
      "scripts/**",
      "supabase/migrations/**",
    ],
  },
};

export default nextConfig;
