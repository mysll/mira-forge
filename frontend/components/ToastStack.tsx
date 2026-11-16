"use client";

import { useEffect } from "react";

export type ToastItem = { id: number; text: string };

type Props = {
  items: ToastItem[];
  onDismiss: (id: number) => void;
};

export default function ToastStack({ items, onDismiss }: Props) {
  return (
    <div className="pointer-events-none fixed bottom-[200px] right-6 z-50 flex w-[280px] flex-col gap-2">
      {items.map((item) => (
        <Toast key={item.id} item={item} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function Toast({ item, onDismiss }: { item: ToastItem; onDismiss: (id: number) => void }) {
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(item.id), 2600);
    return () => clearTimeout(timer);
  }, [item.id, onDismiss]);

  return (
    <div className="pointer-events-auto flex items-start gap-2 rounded-xl border border-edge bg-surface2/95 px-3 py-2 text-xs leading-relaxed text-ink shadow-pop backdrop-blur">
      <svg viewBox="0 0 24 24" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accentSoft" fill="none" aria-hidden>
        <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.6" />
        <path d="M12 8v4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        <circle cx="12" cy="16" r="1" fill="currentColor" />
      </svg>
      <span className="flex-1">{item.text}</span>
    </div>
  );
}
