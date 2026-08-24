import { ImageResponse } from "next/og";

// Android "홈 화면에 추가"(PWA manifest)용 512x512 아이콘(스플래시 화면 등에
// 큰 해상도가 필요해 별도로 둔다). app/icon-192/route.tsx와 동일한 디자인.
export async function GET() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#2563eb",
        }}
      >
        <svg width="320" height="320" viewBox="0 0 32 32" fill="none">
          <rect x="7" y="18" width="5" height="7" rx="1" fill="#ffffff" />
          <rect x="13.5" y="13" width="5" height="12" rx="1" fill="#ffffff" />
          <rect x="20" y="7" width="5" height="18" rx="1" fill="#ffffff" />
        </svg>
      </div>
    ),
    { width: 512, height: 512 }
  );
}
