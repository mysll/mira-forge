"""后台 worker 包。

P1 仅占位：P2 将加入 generation_worker（串行消费 pending 任务、调用 ComfyUI）
与 task_scheduler（按 WORKER_CONCURRENCY 排队）。
"""
