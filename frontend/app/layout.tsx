import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";
import Sidebar from "@/components/Sidebar";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "MiraForge 工作台",
  description: "本地 AI 图片生成与编辑工作台",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="h-screen overflow-hidden text-ink antialiased">
        <Providers>
          <div className="flex h-screen w-full overflow-hidden">
            <Sidebar />
            <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">{children}</div>
          </div>
        </Providers>
      </body>
    </html>
  );
}
