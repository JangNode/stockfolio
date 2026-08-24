import type { MetadataRoute } from "next";

// Android "홈 화면에 추가"(PWA)가 참조하는 매니페스트. 지금까지 없어서
// 이름/아이콘 없이 기본값("Create Next App" + Next.js 기본 아이콘)이 뜨고 있었다.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Stockfolio",
    short_name: "Stockfolio",
    icons: [
      { src: "/icon-192", sizes: "192x192", type: "image/png" },
      { src: "/icon-512", sizes: "512x512", type: "image/png" },
    ],
    theme_color: "#2563eb",
    background_color: "#ffffff",
    display: "standalone",
  };
}
