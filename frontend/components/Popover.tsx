"use client";

import { useEffect, useRef, useState } from "react";

type Props = {
  label: React.ReactNode;
  title?: string;
  active?: boolean;
  align?: "left" | "right";
  width?: number;
  children: (close: () => void) => React.ReactNode;
};

/** 底部参数栏用的小弹出层：点开、点外面关闭，不占常驻空间。 */
export default function Popover({ label, title, active, align = "left", width = 260, children }: Props) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        title={title}
        onClick={() => setOpen((value) => !value)}
        className={[
          "pill",
          active || open ? "border-accent/50 bg-accent/12 text-accentSoft" : "",
        ].join(" ")}
      >
        {label}
        <svg viewBox="0 0 24 24" className="h-3 w-3 opacity-60" fill="none" aria-hidden>
          <path d="m7 10 5 5 5-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open ? (
        <div
          className={[
            "absolute bottom-11 z-30 rounded-xl border border-edge bg-surface p-2 shadow-pop",
            align === "right" ? "right-0" : "left-0",
          ].join(" ")}
          style={{ width }}
        >
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}
