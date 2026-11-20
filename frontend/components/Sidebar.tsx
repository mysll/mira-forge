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
  /** 在这一项上方画一条细分隔线，用来分组 */
  divider?: boolean;
};

const iconClass = "h-[18px] w-[18px]";

const HomeIcon = (
  <svg viewBox="0 0 24 24" fill="none" className={iconClass} aria-hidden>
    <path
      d="M4 10.6 12 4l8 6.6V19a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19v-8.4Z"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
    />
    <path d="M9.5 20.5v-6h5v6" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
  </svg>
);

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

const ToolsIcon = (
  <svg viewBox="0 0 24 24" fill="none" className={iconClass} aria-hidden>
    <path
      d="M14.7 4.6a4.2 4.2 0 0 0-5.3 5.3L4.2 15a2 2 0 1 0 2.8 2.8l5.1-5.2a4.2 4.2 0 0 0 5.3-5.3l-2.2 2.2-2.1-.6-.6-2.1 2.2-2.2Z"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
    />
    <path d="m16.4 15.6 4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);

const TrashIcon = (
  <svg viewBox="0 0 24 24" fill="none" className={iconClass} aria-hidden>
    <path
      d="M4.5 7h15M9.5 7V5.4c0-.5.4-.9.9-.9h3.2c.5 0 .9.4.9.9V7"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M6.5 7l.8 11.2c0 .7.6 1.3 1.3 1.3h6.8c.7 0 1.3-.6 1.3-1.3L17.5 7"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
    />
    <path d="M10.2 10.6v5.6M13.8 10.6v5.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
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

const ScenesIcon = (
  <svg viewBox="0 0 24 24" fill="none" className={iconClass} aria-hidden>
    <rect x="3.2" y="8.5" width="10.6" height="8.5" rx="1.6" stroke="currentColor" strokeWidth="1.6" />
    <path
      d="M16.4 6.2h3.4a1.6 1.6 0 0 1 1.6 1.6v6.9a1.6 1.6 0 0 1-1.6 1.6h-3.4"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
    />
    <path d="M5.6 20.2h9.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    <circle cx="17.4" cy="3.9" r="1.7" stroke="currentColor" strokeWidth="1.4" opacity="0.75" />
  </svg>
);

const ITEMS: NavItem[] = [
  { label: "首页", href: "/", icon: HomeIcon },
  { label: "资产", href: "/gallery", icon: GalleryIcon },
  // 工具是本地编辑器入口，和生成没有关系，所以紧挨着资产放
  { label: "工具", href: "/tools", icon: ToolsIcon, hint: "本地图片工具" },
  { label: "回收站", href: "/trash", icon: TrashIcon, hint: "删除的产物，30 天内可恢复" },
  // 文生图与图片编辑合并成「图片」：进页面默认文生图，编辑模式在创作框里切
  { label: "图片", href: "/compose", icon: ImageIcon, mode: "text_to_image", divider: true },
  { label: "视频", href: "/video", icon: VideoIcon, hint: "视频生成" },
  // 场景是「按地点/剧情分组的图片库」，产物不进图片页，所以和图片、视频并列
  { label: "场景", href: "/scenes", icon: ScenesIcon, hint: "按地点或剧情组织的图集" },
  { label: "设置", href: "/settings", icon: SettingsIcon, divider: true },
];

export default function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const setMode = useComposerStore((state) => state.setMode);

  const isActive = (item: NavItem): boolean => {
    if (item.disabled) {
      return false;
    }
    if (item.href === "/") {
      return pathname === "/";
    }
    return pathname === item.href || pathname.startsWith(`${item.href}/`);
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
            <div key={item.label} className="flex w-full flex-col items-center">
              {item.divider ? <span className="my-1.5 h-px w-6 bg-edge" aria-hidden /> : null}
              <button
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
            </div>
          );
        })}
      </nav>

      {/* 留出底部空间，避免被 Next 的调试指示器（左下角）压住 */}
      <div className="mt-auto flex flex-col items-center px-2 pb-10">
        <span className="text-[10px] text-muted/50">v0.1</span>
      </div>
    </aside>
  );
}
