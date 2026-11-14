import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";
import { SiteHeader } from "@/components/SiteHeader";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "MiraForge",
  description: "本地 AI 图片生成与编辑平台",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen text-slate-200 antialiased">
        <Providers>
          <SiteHeader />
          {children}
        </Providers>
      </body>
    </html>
  );
}
