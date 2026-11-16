"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import ConfirmDialog from "@/components/ConfirmDialog";
import {
  activateProject,
  ApiError,
  createProject,
  deleteProject,
  fetchProjects,
  renameProject,
} from "@/lib/api";
import type { ProjectRead } from "@/types/api";

type Props = {
  /** 切换 / 新建 / 删除之后给用户一句反馈 */
  onToast?: (message: string) => void;
};

function messageOf(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return fallback;
}

/**
 * 项目切换器：一个项目就是 data/projects/<id> 下一个独立文件夹，
 * 切换项目会同时换掉数据库和图片目录，所以这里切换后要清空整个查询缓存。
 */
export default function ProjectSwitcher({ onToast }: Props) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [pendingDelete, setPendingDelete] = useState<ProjectRead | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const projects = useQuery({ queryKey: ["projects"], queryFn: fetchProjects, staleTime: 5_000 });
  const items = projects.data?.items ?? [];
  const active = items.find((item) => item.id === projects.data?.active) ?? items[0] ?? null;

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setCreating(false);
        setRenaming(null);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        setCreating(false);
        setRenaming(null);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  /** 换项目等于换了一整套数据，缓存必须整体作废 */
  const refreshAll = () => {
    queryClient.clear();
    void queryClient.invalidateQueries();
  };

  const switchTo = useMutation({
    mutationFn: (id: string) => activateProject(id),
    onSuccess: (project) => {
      setOpen(false);
      refreshAll();
      onToast?.(`已切换到「${project.name}」`);
    },
    onError: (error) => onToast?.(messageOf(error, "切换项目失败")),
  });

  const create = useMutation({
    mutationFn: (name: string) => createProject(name),
    onSuccess: (project) => {
      setNewName("");
      setCreating(false);
      setOpen(false);
      refreshAll();
      onToast?.(`已新建并切换到「${project.name}」`);
    },
    onError: (error) => onToast?.(messageOf(error, "新建项目失败")),
  });

  const rename = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => renameProject(id, name),
    onSuccess: (project) => {
      setRenaming(null);
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      onToast?.(`已重命名为「${project.name}」`);
    },
    onError: (error) => onToast?.(messageOf(error, "重命名失败")),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteProject(id),
    onSuccess: (body) => {
      setPendingDelete(null);
      const removed = pendingDelete?.name ?? "项目";
      queryClient.setQueryData(["projects"], body);
      refreshAll();
      onToast?.(`已删除「${removed}」`);
    },
    onError: (error) => {
      setPendingDelete(null);
      onToast?.(messageOf(error, "删除项目失败"));
    },
  });

  const submitCreate = () => {
    const name = newName.trim();
    if (!name || create.isPending) {
      return;
    }
    create.mutate(name);
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className={[
          "flex h-9 items-center gap-1.5 rounded-lg border px-2.5 text-xs transition",
          open
            ? "border-accent/50 bg-accent/15 text-accentSoft"
            : "border-edge bg-surface2 text-ink/90 hover:border-accent/40",
        ].join(" ")}
        title="切换项目：每个项目有独立的数据与图片目录"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-muted" fill="none" aria-hidden>
          <path
            d="M4 8.5A2.5 2.5 0 0 1 6.5 6h3l1.6 1.8h6.4A2.5 2.5 0 0 1 20 10.3v6.2a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5v-8Z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
        </svg>
        <span className="max-w-[9rem] truncate">{active?.name ?? "项目"}</span>
        <svg viewBox="0 0 24 24" className="h-3 w-3 text-muted/50" fill="none" aria-hidden>
          <path d="m8 10 4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open ? (
        <div
          className="absolute left-0 top-11 z-30 w-72 overflow-hidden rounded-xl border border-edge bg-surface shadow-pop"
          role="menu"
        >
          <div className="max-h-72 overflow-y-auto scroll-thin py-1">
            {items.map((project) => {
              const isActive = project.id === active?.id;
              if (renaming === project.id) {
                return (
                  <div key={project.id} className="px-2 py-1.5">
                    <input
                      autoFocus
                      value={renameValue}
                      onChange={(event) => setRenameValue(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          const name = renameValue.trim();
                          if (name && !rename.isPending) {
                            rename.mutate({ id: project.id, name });
                          }
                        }
                        if (event.key === "Escape") {
                          setRenaming(null);
                        }
                      }}
                      className="h-8 w-full rounded-md border border-accent/50 bg-surface2 px-2 text-xs text-ink outline-none"
                    />
                  </div>
                );
              }
              return (
                <div
                  key={project.id}
                  className={[
                    "group flex items-center gap-2 px-2 py-1.5",
                    isActive ? "bg-accent/10" : "hover:bg-surface2",
                  ].join(" ")}
                >
                  <button
                    type="button"
                    onClick={() => {
                      if (!isActive) {
                        switchTo.mutate(project.id);
                      } else {
                        setOpen(false);
                      }
                    }}
                    disabled={switchTo.isPending}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    <span
                      className={[
                        "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
                        isActive ? "border-accent bg-accent text-white" : "border-edge/80 text-transparent",
                      ].join(" ")}
                    >
                      <svg viewBox="0 0 24 24" className="h-2.5 w-2.5" fill="none" aria-hidden>
                        <path d="m5 12.5 4.5 4.5L19 7.5" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-xs text-ink">{project.name}</span>
                      <span className="block truncate text-[10px] text-muted/70">
                        {project.created_at.slice(0, 10)} · {project.id}
                      </span>
                    </span>
                  </button>
                  <span className="flex shrink-0 items-center gap-1 opacity-0 transition group-hover:opacity-100">
                    <button
                      type="button"
                      onClick={() => {
                        setRenaming(project.id);
                        setRenameValue(project.name);
                      }}
                      className="rounded p-1 text-muted hover:text-ink"
                      title="重命名"
                    >
                      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" aria-hidden>
                        <path d="M5 19h3l9.5-9.5-3-3L5 16v3Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      onClick={() => setPendingDelete(project)}
                      disabled={items.length <= 1}
                      className="rounded p-1 text-muted transition hover:text-bad disabled:cursor-not-allowed disabled:opacity-30"
                      title={items.length <= 1 ? "至少要保留一个项目" : "删除项目（连同它的数据库与图片）"}
                    >
                      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" aria-hidden>
                        <path d="M5 7h14M9 7V5h6v2m-8 0 1 12h8l1-12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                  </span>
                </div>
              );
            })}
          </div>

          <div className="border-t border-edge/70 p-2">
            {creating ? (
              <div className="flex items-center gap-1.5">
                <input
                  autoFocus
                  value={newName}
                  onChange={(event) => setNewName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      submitCreate();
                    }
                    if (event.key === "Escape") {
                      setCreating(false);
                      setNewName("");
                    }
                  }}
                  placeholder="项目名称"
                  maxLength={40}
                  className="h-8 min-w-0 flex-1 rounded-md border border-accent/50 bg-surface2 px-2 text-xs text-ink outline-none placeholder:text-muted/60"
                />
                <button
                  type="button"
                  onClick={submitCreate}
                  disabled={create.isPending || !newName.trim()}
                  className="btn-primary h-8 px-2.5 text-xs disabled:opacity-50"
                >
                  {create.isPending ? "创建中" : "创建"}
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setCreating(true)}
                className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-xs text-muted transition hover:bg-surface2 hover:text-ink"
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" aria-hidden>
                  <path d="M12 6v12M6 12h12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
                新建项目
              </button>
            )}
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        open={pendingDelete !== null}
        title={`删除项目「${pendingDelete?.name ?? ""}」？`}
        description={
          <>
            这个项目自己的数据库与全部图片会被删除，
            <strong className="text-ink">文件夹从磁盘移除且无法恢复</strong>。
            其它项目不受影响。
          </>
        }
        confirmLabel="删除项目"
        danger
        busy={remove.isPending}
        onConfirm={() => {
          if (pendingDelete) {
            remove.mutate(pendingDelete.id);
          }
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
