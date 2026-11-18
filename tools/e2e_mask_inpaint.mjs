// 端到端验证：图片编辑 → 第 1 张图悬浮出「遮罩」→ 悬浮编辑器里涂一笔 → 应用 → 遮罩卡片出现
//   → 提交后这一单必须是 image_inpaint（后端把它路由到局部编辑工作流），并且遮罩卡片被清空。
// 用法：node tools/e2e_mask_inpaint.mjs [--base ...] [--api ...] [--image ...] [--no-submit]
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const get = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const has = (name) => args.includes(`--${name}`);

const base = get("base", "http://127.0.0.1:3000");
const api = get("api", "http://127.0.0.1:8000/api/v1");
const imagePath = resolve(get("image", "data/img27.png"));
const port = Number(get("port", "9487"));
const profile = mkdtempSync(join(tmpdir(), "dsh-mask-inpaint-"));

const edge = spawn(
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--window-size=1500,950",
    "about:blank",
  ],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function wsUrl() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((item) => item.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* 端口还没起来 */
    }
    await sleep(200);
  }
  throw new Error("连不上调试端口");
}

const ws = new WebSocket(await wsUrl());
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});

let nextId = 1;
const pending = new Map();
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
};

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, (message) => {
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });

const evaluate = async (expression) => {
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "eval 失败");
  return result.result.value;
};

const waitFor = async (expression, timeoutMs, label) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return true;
    await sleep(300);
  }
  throw new Error(`等待超时：${label}`);
};

const centerOf = (selector) =>
  evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return null;
    node.scrollIntoView({ block: "center" });
    const rect = node.getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), w: Math.round(rect.width), h: Math.round(rect.height) };
  })()`);

const hoverAt = async (x, y) => {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
};

const clickAt = async (x, y) => {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
};

await send("Page.enable");
await send("Runtime.enable");
await send("DOM.enable");
await send("Page.navigate", { url: `${base}/compose` });
await sleep(3000);

// 切到「图片编辑」
await evaluate(`(() => {
  const tab = [...document.querySelectorAll("button")].find((node) => node.textContent?.trim() === "图片编辑");
  tab?.click();
  return !!tab;
})()`);
await sleep(500);

// 两个隐藏 input 都带 multiple，handleFiles 会按当前模式决定进哪个 store
const doc = await send("DOM.getDocument", { depth: -1 });
const input = await send("DOM.querySelector", {
  nodeId: doc.root.nodeId,
  selector: 'input[type="file"]',
});
if (!input?.nodeId) throw new Error("没找到编辑模式的参考图输入框");
await send("DOM.setFileInputFiles", { nodeId: input.nodeId, files: [imagePath] });
await waitFor(`document.querySelectorAll("[data-slot] img").length > 0`, 10000, "参考图缩略图出现");
await sleep(400);

// 悬浮第 1 张 → 「遮罩」按钮出现
const slot = await centerOf("[data-slot]");
await hoverAt(slot.x, slot.y);
await sleep(300);
const maskButton = await evaluate(`(() => {
  const button = document.querySelector("[data-mask-button]");
  if (!button) return { found: false };
  const rect = button.getBoundingClientRect();
  return { found: true, visible: getComputedStyle(button).display !== "none", x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
})()`);
if (!maskButton.found || !maskButton.visible) throw new Error(`遮罩按钮没出现：${JSON.stringify(maskButton)}`);
await clickAt(maskButton.x, maskButton.y);
await waitFor(`!!document.querySelector("[data-mask-canvas]")`, 8000, "遮罩编辑器打开");
await waitFor(`(() => {
  const canvas = document.querySelector("[data-mask-canvas]");
  return canvas && canvas.width > 32;
})()`, 8000, "遮罩画布已按原图尺寸就绪");

// 在画布中间横向涂一笔
const canvas = await centerOf("[data-mask-canvas]");
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: canvas.x - 60, y: canvas.y, button: "none" });
await send("Input.dispatchMouseEvent", { type: "mousePressed", x: canvas.x - 60, y: canvas.y, button: "left", clickCount: 1 });
for (let step = 1; step <= 12; step += 1) {
  const x = canvas.x - 60 + (step * 120) / 12;
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y: canvas.y, button: "left", buttons: 1 });
  await sleep(16);
}
await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: canvas.x + 60, y: canvas.y, button: "left", clickCount: 1 });
await sleep(200);

const painted = await evaluate(`(() => {
  const canvas = document.querySelector("[data-mask-canvas]");
  const context = canvas.getContext("2d");
  const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
  let covered = 0;
  for (let offset = 3; offset < data.length; offset += 4) {
    if (data[offset] > 8) covered += 1;
  }
  return { width: canvas.width, height: canvas.height, covered, ratio: +(covered / (canvas.width * canvas.height)).toFixed(4) };
})()`);

// 应用遮罩
const applied = await evaluate(`(() => {
  const button = [...document.querySelectorAll("button")].find((node) => node.textContent?.trim() === "应用遮罩");
  if (!button) return "missing";
  button.click();
  return "clicked";
})()`);

let slotState = null;
if (applied === "clicked") {
  await waitFor(`!!document.querySelector("[data-mask-slot]")`, 8000, "遮罩卡片出现");
  slotState = await evaluate(`(() => {
    const card = document.querySelector("[data-mask-slot]");
    const img = card?.querySelector("img");
    return {
      label: card?.textContent?.trim() ?? null,
      hasPreview: !!img && img.src.startsWith("blob:"),
      thumbWidth: img?.naturalWidth ?? 0,
      editorClosed: !document.querySelector("[data-mask-canvas]"),
      slotCount: document.querySelectorAll("[data-slot]").length,
    };
  })()`);
}

let submitted = null;
if (!has("no-submit")) {
  await evaluate(`(() => {
    const textarea = document.querySelector("textarea");
    if (!textarea) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    setter.call(textarea, "keep the pose and the cloak, only repaint the chest");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  await sleep(400);
  const clicked = await evaluate(`(() => {
    const button = [...document.querySelectorAll("button")].find((node) => {
      const text = node.textContent?.trim() ?? "";
      return text.startsWith("编辑出图");
    });
    if (!button) return "missing";
    if (button.disabled) return "disabled";
    button.click();
    return button.textContent?.trim() ?? "ok";
  })()`);
  await sleep(2500);
  const after = await evaluate(`(() => ({
    prompt: document.querySelector("textarea")?.value ?? null,
    maskCard: !!document.querySelector("[data-mask-slot]"),
  }))()`);
  const newest = await evaluate(`fetch("${api}/generations?media=image&limit=1")
    .then((r) => r.json())
    .then((data) => {
      const item = data.items?.[0];
      return item
        ? { id: item.id, type: item.generation_type, hasMask: item.has_mask, refs: item.reference_images?.length ?? 0 }
        : null;
    })`);
  submitted = { clicked, after, newest };
}

console.log(
  JSON.stringify(
    { imagePath, maskButton, painted, applied, slotState, submitted },
    null,
    2,
  ),
);

ws.close();
edge.kill();
process.exit(0);
