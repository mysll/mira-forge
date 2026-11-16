"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

import { useComposerStore } from "@/stores/composer";

type NavItem = {
  label: string;
  href: string;
  icon: React.ReactNode;
  /** 点击后要把创作框切到哪个模式（只对创作页有意义） */
  mode?: "text_to_image" | "image_edit";
  disabled?: boolean;
  hint?: string;
};

const iconClass = "h-[18px] w-[18px]";

const GalleryIcon = (
  <svg viewBox="0 0 24 24" fill="none" className={iconClass} aria-hidden>
    <rect x="3.5" y="4.5" width="7" height="7" rx="1.6" stroke="currentColor" strokeWidth="1.6" />
    <rect x="13.5" y="4.5" width="7" height="7" rx="1.6" stroke="currentColor" strokeWidth="1.6" />
    <rect x="3.5" y="14.5" width="7" height="5" rx="1.6" stroke="currentColor" strokeWidth="1.6" />
    <rect x="13.5" y="14.5" width="7" height="5" rx="1.6" stroke="currentColor" strokeWidth="1.6" />
  </svg>
);

const ImageIcon = (
  <svg viewBox="0 0 24 24" fill="none" className={iconClass} aria-hidden>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" stroke="currentColor" strokeWidth="1.6" />
    <circle cx="9" cy="10" r="1.6" fill="currentColor" />
    <path
      d="m4.5 17 4.4-4.2 3.1 3 2.6-2.4 5 4.1"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const VideoIcon = (
  <svg viewBox="0 0 24 24" fill="none" className={iconClass} aria-hidden>
    <rect x="3" y="5.5" width="13" height="13" rx="2.5" stroke="currentColor" strokeWidth="1.6" />
    <path
      d="m16 11.2 4.2-2.6v6.8L16 12.8"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
    />
  </svg>
);

const SettingsIcon = (
  <svg viewBox="0 0 24 24" fill="none" className={iconClass} aria-hidden>
    <circle cx="12" cy="12" r="3.1" stroke="currentColor" strokeWidth="1.6" />
    <path
      d="M12 3.6v2.2M12 18.2v2.2M4.9 7.9l1.9 1.1M17.2 15l1.9 1.1M4.9 16.1l1.9-1.1M17.2 9l1.9-1.1"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
    />
  </svg>
);

const ITEMS: NavItem[] = [
  { label: "资产", href: "/gallery", icon: GalleryIcon },
  // 文生图与图片编辑合并成「图片」：进页面默认文生图，编辑模式在创作框里切
  { label: "图片", href: "/", icon: ImageIcon, mode: "text_to_image" },
  { label: "视频", href: "#", icon: VideoIcon, disabled: true, hint: "视频生成在二期开放" },
  { label: "设置", href: "/settings", icon: SettingsIcon },
];

export default function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const setMode = useComposerStore((state) => state.setMode);

  const isActive = (item: NavItem): boolean => {
    if (item.disabled) {
      return false;
    }
    if (item.href === "/gallery") {
      return pathname.startsWith("/gallery");
    }
    if (item.href === "/settings") {
      return pathname.startsWith("/settings");
    }
    return pathname === "/";
  };

  return (
    <aside className="flex h-full w-[72px] shrink-0 flex-col items-center gap-1 border-r border-edge/70 bg-rail py-3">
      <Link
        href="/gallery"
        className="mb-3 flex h-9 w-9 items-center justify-center rounded-xl bg-accent/20"
        title="MiraForge"
      >
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" aria-hidden>
          <path
            d="M6 18V7l6 6 6-6v11"
            stroke="#b9a7ff"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </Link>

      <nav className="flex w-full flex-col items-center gap-1 px-2">
        {ITEMS.map((item) => {
          const active = isActive(item);
          const className = [
            "flex w-full flex-col items-center gap-1 rounded-xl px-1 py-2 text-[10px] transition",
            active
              ? "bg-accent/15 text-accentSoft"
              : item.disabled
                ? "cursor-not-allowed text-muted/40"
                : "text-muted hover:bg-surface2 hover:text-ink",
          ].join(" ");

          if (item.disabled) {
            return (
              <span key={item.label} className={className} title={item.hint}>
                {item.icon}
                <span className="leading-none">{item.label}</span>
              </span>
            );
          }

          return (
            <button
              key={item.label}
              type="button"
              className={className}
              title={item.hint ?? item.label}
              onClick={() => {
                if (item.mode) {
                  setMode(item.mode);
                }
                router.push(item.href);
              }}
            >
              {item.icon}
              <span className="leading-none">{item.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="mt-auto flex flex-col items-center gap-2 px-2 pb-1">
        <span className="rounded-md border border-edge px-1.5 py-0.5 text-[10px] text-muted/70">
          一期
        </span>
        <span className="text-[10px] text-muted/50">v0.1</span>
      </div>
    </aside>
  );
}
