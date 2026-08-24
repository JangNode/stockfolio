import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

// iOS "홈 화면에 추가"는 favicon(app/icon.svg)이 아니라 이 apple-touch-icon을
// 쓴다 — 지금까지 없어서 Next.js/Vercel 기본 아이콘("Create Next App" 삼각형
// 로고)이 대신 뜨고 있었다. app/icon.svg와 같은 디자인(상승 막대그래프)을
// PNG로 렌더링한다(Apple은 SVG 아이콘을 지원하지 않는다).
export default function AppleIcon() {
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
        <svg width="112" height="112" viewBox="0 0 32 32" fill="none">
          <rect x="7" y="18" width="5" height="7" rx="1" fill="#ffffff" />
          <rect x="13.5" y="13" width="5" height="12" rx="1" fill="#ffffff" />
          <rect x="20" y="7" width="5" height="18" rx="1" fill="#ffffff" />
        </svg>
      </div>
    ),
    { ...size }
  );
}
