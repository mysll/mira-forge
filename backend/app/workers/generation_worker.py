"""单协程生成 Worker：串行地把 pending 任务送到 ComfyUI 并收产物。

设计要点：
- 只有一个 GPU，所以严格串行（PROJECT.md 的 WORKER_CONCURRENCY=1）。
- 多项目：一次只处理一个项目的一个任务，项目之间轮转，所以切到别的项目时
  原项目的排队任务照样会继续生成。
- 任务状态全部落库，进程重启后未完成的任务仍能被下一轮捡起。
- 进度来自 ComfyUI 的 /ws 消息，结果以 /history 为准（WS 断线不影响正确性）。
"""

from __future__ import annotations

import asyncio
import logging
import math
import os
import uuid
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import select

from app.core.config import get_settings
from app.core.events import manager
from app.core.projects import Project, list_projects
from app.models.database import session_for
from app.models.generation import Generation, GenerationStatus, GenerationType
from app.models.task import GenerationTask, TaskStatus
from app.schemas.generation import TaskRead
from app.services import workflow_service
from app.services.comfyui_client import ComfyUIClient, ComfyUIError
from app.services.generation_service import decode_reference_paths
from app.services.image_service import ImageStoreError, read_storage_file, store_image
from app.services.prompt_builder import PromptBuildError, build_prompt, load_graph
from app.services.workflow_config import WorkflowConfig, WorkflowConfigError, load_workflow_config

logger = logging.getLogger("miraforge.worker")

PROGRESS_MIN_STEP = 2  # 进度百分比变化小于它就不写库，省得刷爆 SQLite
HISTORY_POLL_SECONDS = 1.0
TASK_TIMEOUT_SECONDS = 1800  # 单张图最长等 30 分钟，超时判失败
IDLE_SLEEP_SECONDS = 1.0


@dataclass
class _Plan:
    """一张图要提交的东西：图本身 + 参考图（编辑 / 图生图时才有，可多张）。"""

    generation_id: int
    graph: dict[str, Any]
    config: WorkflowConfig
    params: dict[str, Any]
    reference_paths: list[str] = field(default_factory=list)


def _edit_resolution(width: int | None, height: int | None) -> int:
    """把「目标宽高」折成 Qwen 编码器的 resolution（约等于面积开方，对齐 32）。

    节点内部按 sqrt(resolution² × 参考图比例) 算实际宽高，所以这里只给量级。
    """
    if not width or not height:
        return 1024
    area = math.sqrt(width * height)
    return max(256, min(4096, int(round(area / 32) * 32)))


def _suffix(path: str) -> str:
    extension = os.path.splitext(path)[1].lower()
    return extension if extension in {".png", ".jpg", ".jpeg", ".webp"} else ".png"


class GenerationWorker:
    def __init__(self, client: ComfyUIClient | None = None) -> None:
        self.client = client or ComfyUIClient()
        # ComfyUI 用 client_id 区分 WS 订阅者，提交与订阅必须是同一个
        self.client_id = f"miraforge-{uuid.uuid4().hex[:12]}"
        self._stop = asyncio.Event()
        self._runner: asyncio.Task[None] | None = None
        # 进度节流表：key 必须带项目，否则两个项目的 task id 会互相覆盖
        self._last_broadcast: dict[str, int] = {}
        self._cursor = 0

    # ---- 生命周期 ----

    def start(self) -> None:
        if self._runner is not None and not self._runner.done():
            return
        self._stop.clear()
        self._runner = asyncio.create_task(self._loop(), name="miraforge-generation-worker")
        logger.info("生成 worker 已启动")

    async def stop(self) -> None:
        self._stop.set()
        if self._runner is not None:
            try:
                await asyncio.wait_for(self._runner, timeout=10)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                self._runner.cancel()
            self._runner = None
        logger.info("生成 worker 已停止")

    async def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                worked = await self._process_round()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - 单轮失败不能拖垮整个 worker
                logger.exception("worker 单轮出现未预期异常")
                worked = False
            if not worked:
                try:
                    await asyncio.wait_for(self._stop.wait(), timeout=IDLE_SLEEP_SECONDS)
                except asyncio.TimeoutError:
                    pass

    async def _process_round(self) -> bool:
        """所有项目轮转一圈，处理一个任务就返回（保证公平 + 严格串行）。"""
        projects = list_projects()
        if not projects:
            return False
        total = len(projects)
        for offset in range(total):
            project = projects[(self._cursor + offset) % total]
            if self._stop.is_set():
                return False
            if await self._process_next(project):
                self._cursor = (self._cursor + offset + 1) % total
                return True
        return False

    # ---- 任务调度 ----

    async def _process_next(self, project: Project) -> bool:
        task_id = self._claim_pending(project)
        if task_id is None:
            return False
        try:
            await self._execute(project, task_id)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            logger.exception("任务 %s（项目 %s）执行失败", task_id, project.id)
            self._fail(project, task_id, f"内部错误：{exc}")
        return True

    def _claim_pending(self, project: Project) -> int | None:
        with session_for(project) as db:
            task = db.scalar(
                select(GenerationTask)
                .where(GenerationTask.status == TaskStatus.PENDING)
                .order_by(GenerationTask.id)
                .limit(1)
            )
            if task is None:
                return None
            task.status = TaskStatus.QUEUED
            generation = db.get(Generation, task.generation_id)
            if generation is not None and generation.status == GenerationStatus.PENDING:
                generation.status = GenerationStatus.QUEUED
            db.commit()
            return task.id

    # ---- 单个任务 ----

    async def _execute(self, project: Project, task_id: int) -> None:
        plan = self._build_plan(project, task_id)
        if plan is None:
            return  # 已在 _build_plan 里判失败

        generation_id = plan.generation_id
        output_node = plan.config.output_node
        storage_root = project.storage_path

        await self._broadcast_task(project, task_id)
        self._set_task(project, task_id, status=TaskStatus.RUNNING, progress=1, started_at=True)
        self._sync_generation_status(project, generation_id)

        reference_names: list[str] = []
        for index, reference_path in enumerate(plan.reference_paths, start=1):
            try:
                content = read_storage_file(reference_path, storage_root)
                info = await self.client.upload_image(
                    content, f"miraforge_ref_{task_id}_{index}{_suffix(reference_path)}"
                )
            except Exception as exc:  # noqa: BLE001 - 上传失败就是这张图失败
                self._fail(project, task_id, f"上传第 {index} 张参考图失败：{exc}")
                return
            name = info.get("name") or info.get("filename")
            if not name:
                self._fail(project, task_id, f"ComfyUI 未返回参考图文件名：{info}")
                return
            reference_names.append(name)

        try:
            prompt = build_prompt(
                plan.graph, plan.config, plan.params, reference_images=reference_names
            )
        except PromptBuildError as exc:
            self._fail(project, task_id, str(exc))
            return

        try:
            prompt_id = await self.client.submit(prompt, self.client_id)
        except ComfyUIError as exc:
            self._fail(project, task_id, str(exc))
            return
        except Exception as exc:  # noqa: BLE001 - 连不上 ComfyUI 等
            self._fail(project, task_id, f"提交 ComfyUI 失败：{exc}")
            return

        self._set_task(project, task_id, comfy_prompt_id=prompt_id)
        await self._broadcast_task(project, task_id)

        history, cancelled = await self._wait_for_history(project, task_id, prompt_id)
        if cancelled:
            logger.info("任务 %s（项目 %s）已被取消，丢弃这次结果", task_id, project.id)
            self._sync_generation_status(project, generation_id)
            await self._broadcast_task(project, task_id)
            return
        if history is None:
            return  # 超时已被判失败

        status_str = (history.get("status") or {}).get("status_str")
        outputs = history.get("outputs") or {}
        entries = (outputs.get(output_node) or {}).get("images") or []

        if status_str == "error" or not entries:
            self._fail(project, task_id, self._describe_execution_error(history))
            return

        saved = 0
        for index, entry in enumerate(entries):
            try:
                content = await self.client.download(
                    entry.get("filename", ""),
                    entry.get("subfolder", ""),
                    entry.get("type", "output"),
                )
            except Exception as exc:  # noqa: BLE001
                self._fail(project, task_id, f"下载产物失败：{exc}")
                return
            metadata = entry.get("metadata") or {}
            try:
                with session_for(project) as db:
                    store_image(
                        db,
                        content=content,
                        generation_id=generation_id,
                        task_id=task_id,
                        index=index,
                        width=metadata.get("width"),
                        height=metadata.get("height"),
                        storage_root=storage_root,
                    )
                    db.commit()
            except (ImageStoreError, OSError) as exc:
                self._fail(project, task_id, str(exc))
                return
            saved += 1

        self._set_task(
            project,
            task_id,
            status=TaskStatus.COMPLETED,
            progress=100,
            completed_at=True,
            error_message=None,
        )
        self._sync_generation_status(project, generation_id)
        await self._broadcast_task(project, task_id)
        logger.info("任务 %s（项目 %s）完成，产物 %s 张", task_id, project.id, saved)

    def _build_plan(self, project: Project, task_id: int) -> _Plan | None:
        """组装可直接提交的 API 图；配置有问题就在这一步判失败。"""
        with session_for(project) as db:
            task = db.get(GenerationTask, task_id)
            if task is None:
                return None
            generation = db.get(Generation, task.generation_id)
            if generation is None:
                self._fail(project, task_id, "任务所属的生成记录已不存在")
                return None

            model = workflow_service.get_model(generation.model_name)
            if model is None:
                self._fail(project, task_id, f"模型 '{generation.model_name}' 已不在注册表中")
                return None
            target = workflow_service.get_workflow_target(model, generation.generation_type)
            if target is None:
                self._fail(
                    project, task_id, f"模型 '{model.id}' 没有 {generation.generation_type} 工作流"
                )
                return None
            if not target.available:
                self._fail(project, task_id, f"工作流 JSON 不存在：{target.json_path}")
                return None

            params: dict[str, Any] = {
                "prompt": generation.prompt,
                "negative_prompt": generation.negative_prompt or "",
                "seed": task.seed,
                "width": generation.width,
                "height": generation.height,
                "filename_prefix": f"miraforge/g{generation.id}_t{task.id}",
            }
            for key in ("steps", "cfg", "sampler", "scheduler", "denoise"):
                if key in model.defaults:
                    params[key] = model.defaults[key]

            # 用户显式给的参数覆盖默认值；绑定表里没有的键会被 prompt_builder 跳过，
            # 所以 turbo 这类不暴露 steps 的模型多传也不会出错。
            for key in ("steps", "cfg", "sampler"):
                value = getattr(generation, key, None)
                if value is not None:
                    params[key] = value

            reference_paths: list[str] = []
            if generation.generation_type in (
                GenerationType.IMAGE_EDIT,
                GenerationType.IMAGE_TO_IMAGE,
            ):
                reference_paths = decode_reference_paths(
                    generation.reference_image_paths, generation.reference_image_path
                )
                if not reference_paths:
                    self._fail(project, task_id, "缺少参考图，无法执行")
                    return None
                # resolution 决定参考图被缩到多大再进编码器（见 WORKFLOW_MAPPING）
                params["resolution"] = _edit_resolution(generation.width, generation.height)

            try:
                graph = load_graph(target.json_path)
                config = load_workflow_config(target.config_path)
            except (WorkflowConfigError, OSError) as exc:
                self._fail(project, task_id, str(exc))
                return None

            return _Plan(
                generation_id=generation.id,
                graph=graph,
                config=config,
                params=params,
                reference_paths=reference_paths,
            )

    async def _wait_for_history(
        self, project: Project, task_id: int, prompt_id: str
    ) -> tuple[dict[str, Any] | None, bool]:
        """边听 WS 进度边轮询 /history。返回 (history, 是否被用户取消)。"""
        loop = asyncio.get_running_loop()
        deadline = loop.time() + TASK_TIMEOUT_SECONDS
        listener = asyncio.create_task(self._listen_progress(project, task_id, prompt_id))
        try:
            while loop.time() < deadline:
                if self._stop.is_set():
                    return None, False
                if self._is_cancelled(project, task_id):
                    return None, True
                try:
                    history = await self.client.history(prompt_id)
                except Exception as exc:  # noqa: BLE001 - 轮询抖动不算失败
                    logger.debug("查询 history 暂时失败：%s", exc)
                    history = None
                if history is not None:
                    return history, False
                await asyncio.sleep(HISTORY_POLL_SECONDS)
            if self._is_cancelled(project, task_id):
                return None, True
            self._fail(project, task_id, f"等待 ComfyUI 超时（{TASK_TIMEOUT_SECONDS} 秒）")
            return None, False
        finally:
            listener.cancel()
            try:
                await listener
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass

    async def _listen_progress(self, project: Project, task_id: int, prompt_id: str) -> None:
        key = f"{project.id}:{task_id}"
        try:
            async for event in self.client.progress_messages(self.client_id, prompt_id):
                value = int(event.get("value") or 0)
                maximum = int(event.get("max") or 0)
                if maximum <= 0:
                    continue
                percent = max(1, min(99, round(value * 100 / maximum)))
                previous = self._last_broadcast.get(key, 0)
                if percent - previous < PROGRESS_MIN_STEP and percent != 99:
                    continue
                self._last_broadcast[key] = percent
                self._set_task(project, task_id, progress=percent)
                await self._broadcast_task(project, task_id)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - 进度通道坏了不影响结果
            logger.debug("进度监听结束（task=%s）", task_id, exc_info=True)
        finally:
            self._last_broadcast.pop(key, None)

    # ---- 状态写入与广播 ----

    def _is_cancelled(self, project: Project, task_id: int) -> bool:
        with session_for(project) as db:
            task = db.get(GenerationTask, task_id)
            return task is not None and task.status == TaskStatus.CANCELLED

    def _set_task(
        self,
        project: Project,
        task_id: int,
        *,
        started_at: bool = False,
        completed_at: bool = False,
        **fields: Any,
    ) -> None:
        from app.models.workflow import utcnow

        with session_for(project) as db:
            task = db.get(GenerationTask, task_id)
            if task is None:
                return
            # 用户取消之后，worker 不能再把状态改回去
            if task.status == TaskStatus.CANCELLED and fields.get("status") not in (
                None,
                TaskStatus.CANCELLED,
            ):
                return
            for key, value in fields.items():
                setattr(task, key, value)
            if started_at:
                task.started_at = utcnow()
            if completed_at:
                task.completed_at = utcnow()
            db.commit()

    def _fail(self, project: Project, task_id: int, message: str) -> None:
        logger.warning("任务 %s（项目 %s）失败：%s", task_id, project.id, message)
        with session_for(project) as db:
            task = db.get(GenerationTask, task_id)
            if task is None:
                return
            if task.status == TaskStatus.CANCELLED:
                return  # 已取消的任务不必再标失败
            from app.models.workflow import utcnow

            task.status = TaskStatus.FAILED
            task.error_message = message[:2000]
            task.completed_at = utcnow()
            db.commit()
            generation_id = task.generation_id
        self._sync_generation_status(project, generation_id)

    def _sync_generation_status(self, project: Project, generation_id: int) -> None:
        from app.services.generation_service import aggregate_generation_status

        with session_for(project) as db:
            generation = db.get(Generation, generation_id)
            if generation is None:
                return
            statuses = [task.status for task in generation.tasks]
            new_status = aggregate_generation_status(statuses)
            if new_status != generation.status:
                generation.status = new_status
                if new_status in (
                    GenerationStatus.COMPLETED,
                    GenerationStatus.FAILED,
                    GenerationStatus.CANCELLED,
                ):
                    from app.models.workflow import utcnow

                    generation.completed_at = utcnow()
                db.commit()

    async def _broadcast_task(self, project: Project, task_id: int) -> None:
        with session_for(project) as db:
            task = db.get(GenerationTask, task_id)
            if task is None:
                return
            payload = TaskRead.model_validate(task).model_dump(mode="json")
        await manager.broadcast(
            {"type": "task.updated", "project": project.id, "data": payload}
        )

    @staticmethod
    def _describe_execution_error(history: dict[str, Any]) -> str:
        status = history.get("status") or {}
        for message in status.get("messages") or []:
            if isinstance(message, list) and len(message) >= 2 and message[0] == "execution_error":
                detail = message[1] or {}
                node = detail.get("node_type") or detail.get("node_id") or "?"
                text = detail.get("exception_message") or "ComfyUI 执行出错"
                return f"ComfyUI 执行失败（{node}）：{str(text).strip()[:800]}"
        return "ComfyUI 未返回任何图片"


worker = GenerationWorker()


def start_worker() -> None:
    worker.client.base_url = get_settings().comfyui_url.rstrip("/")
    worker.client.ws_url = worker.client.base_url.replace("http://", "ws://").replace(
        "https://", "wss://"
    )
    worker.start()


async def stop_worker() -> None:
    await worker.stop()
