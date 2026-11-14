"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV = [
  { href: "/", label: "生成" },
  { href: "/gallery", label: "画廊" },
];

export function SiteHeader() {
  const pathname = usePathname();

  return (
    <header className="border-b border-edge/60 bg-black/30 backdrop-blur">
      <div className="mx-auto flex w-full max-w-6xl items-center gap-6 px-5 py-3">
        <Link href="/" className="text-lg font-semibold tracking-tight text-slate-100">
          MiraForge
        </Link>
        <nav className="flex gap-1">
          {NAV.map((item) => {
            const active = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`rounded-md px-2.5 py-1 text-xs transition ${
                  active
                    ? "bg-sky-500/10 text-sky-300"
                    : "text-slate-500 hover:text-slate-300"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
        <span className="ml-auto font-mono text-[10px] uppercase tracking-wider text-slate-600">
          local · 127.0.0.1
        </span>
      </div>
    </header>
  );
}
