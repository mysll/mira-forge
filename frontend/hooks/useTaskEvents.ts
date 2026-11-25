"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { TASK_EVENTS_URL } from "@/lib/api";

/**
 * 订阅后端任务事件通道。
 *
 * 事件本身只用来「知道有变化」，真正的数据仍然靠 REST 拉取——
 * 这样即使 WebSocket 断线，界面也不会停在错误的状态上。
 * 进度事件很密（每 2% 一条），这里按 600ms 合并，避免把浏览器打成筛子。
 */
export function useTaskEvents(enabled = true): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!enabled) return;

    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const flush = () => {
      flushTimer = null;
      // 任务事件会改到的不只是作品流：分层/元素/图集/回收站的列表与详情也由它驱动。
      // 各页自己的轮询保留着，这里只是让「正在看的页面」立刻跟上，不必等下一轮。
      for (const queryKey of [
        ["generations"],
        ["images"],
        ["scenes"],
        ["layer-sets"],
        ["layer-generations"],
        ["element-sets"],
        ["element-generations"],
        ["kits"],
        ["kit"],
        ["recycle-bin"],
      ]) {
        void queryClient.invalidateQueries({ queryKey });
      }
    };

    const scheduleFlush = () => {
      if (flushTimer) return;
      flushTimer = setTimeout(flush, 600);
    };

    const connect = () => {
      if (closed) return;
      socket = new WebSocket(TASK_EVENTS_URL);
      socket.onmessage = (event) => {
        if (typeof event.data !== "string") return;
        try {
          const message = JSON.parse(event.data) as { type?: string };
          if (message.type === "task.updated") scheduleFlush();
        } catch {
          // 忽略非法帧
        }
      };
      socket.onclose = () => {
        if (closed) return;
        retryTimer = setTimeout(connect, 2_000); // 后端重启时自动重连
      };
      socket.onerror = () => socket?.close();
    };

    connect();

    return () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (flushTimer) clearTimeout(flushTimer);
      socket?.close();
    };
  }, [enabled, queryClient]);
}
