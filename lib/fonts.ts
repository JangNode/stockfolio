import { IBM_Plex_Sans_KR } from "next/font/google";

/**
 * 공통 디자인 시스템의 표시용 폰트. 전역 폰트(app/layout.tsx의 Geist)는 그대로 두고,
 * 화면 컴포넌트가 이 모듈을 import해서 필요한 곳에만 `ibmPlexSansKr.className`을
 * 적용하는 방식으로 화면별로 순서대로 적용한다.
 */
export const ibmPlexSansKr = IBM_Plex_Sans_KR({
  weight: ["400", "500", "600", "700"],
  subsets: ["latin"],
});
