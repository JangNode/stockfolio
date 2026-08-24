import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { MarketProvider } from "@/components/MarketContext";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Stockfolio",
  description: "로그인 기반 주식 정보 대시보드",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <MarketProvider>{children}</MarketProvider>
      </body>
    </html>
  );
}
