"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

import { useComposerStore, type ComposerMode } from "@/stores/composer";

type NavItem = {
  label: string;
  href: string;
  icon: React.ReactNode;
  mode?: ComposerMode;
  disabled?: boolean;
  hint?: string;
};

const iconClass = "h-[18px] w-[18px]";

const HomeIcon = (
  <svg viewBox="0 0 24 24" fill="none" className={iconClass} aria-hidden>
    <path
      d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1v-9.5Z"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
    />
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

const EditIcon = (
  <svg viewBox="0 0 24 24" fill="none" className={iconClass} aria-hidden>
    <path
      d="M4 20h4.2l9.4-9.4a2.3 2.3 0 0 0 0-3.2l-1-1a2.3 2.3 0 0 0-3.2 0L4 15.8V20Z"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
    />
    <path d="m13.4 7.8 2.8 2.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
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

export default function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const mode = useComposerStore((state) => state.mode);
  const setMode = useComposerStore((state) => state.setMode);

  const items: NavItem[] = [
    { label: "作品", href: "/", icon: HomeIcon },
    { label: "文生图", href: "/", icon: ImageIcon, mode: "text_to_image" },
    { label: "图片编辑", href: "/", icon: EditIcon, mode: "image_edit" },
    {
      label: "视频",
      href: "#",
      icon: VideoIcon,
      disabled: true,
      hint: "视频生成在二期开放",
    },
    { label: "设置", href: "/settings", icon: SettingsIcon },
  ];

  const isActive = (item: NavItem): boolean => {
    if (item.disabled) {
      return false;
    }
    if (item.href === "/settings") {
      return pathname === "/settings";
    }
    if (pathname === "/settings") {
      return false;
    }
    if (item.label === "作品") {
      return true;
    }
    return mode === item.mode;
  };

  return (
    <aside className="flex h-full w-[72px] shrink-0 flex-col items-center gap-1 border-r border-edge/70 bg-rail py-3">
      <Link
        href="/"
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
        {items.map((item) => {
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
