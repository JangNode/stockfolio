import { ImageResponse } from "next/og";

// Android "홈 화면에 추가"(PWA manifest)용 192x192 아이콘. app/manifest.ts의
// icons 배열이 이 라우트를 참조한다. app/icon.svg(파비콘)와 같은 디자인을
// manifest가 요구하는 실제 픽셀 크기의 PNG로 렌더링한다.
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
        <svg width="120" height="120" viewBox="0 0 32 32" fill="none">
          <rect x="7" y="18" width="5" height="7" rx="1" fill="#ffffff" />
          <rect x="13.5" y="13" width="5" height="12" rx="1" fill="#ffffff" />
          <rect x="20" y="7" width="5" height="18" rx="1" fill="#ffffff" />
        </svg>
      </div>
    ),
    { width: 192, height: 192 }
  );
}
