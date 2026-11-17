// 端到端验证：内嵌的 SpriteForge iframe 能真正吃进一个视频并抽出序列帧。
// 用法：node tools/e2e_spriteforge.mjs [--video data/video-t2v-3s.mp4] [--base http://127.0.0.1:3000]
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const get = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};

const base = get("base", "http://127.0.0.1:3000");
const video = resolve(get("video", "data/video-t2v-3s.mp4"));
const port = Number(get("port", "9466"));

const profile = mkdtempSync(join(tmpdir(), "dsh-sprite-"));
const edge = spawn(
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--disable-gpu",
    "--window-size=1400,900",
    "about:blank",
  ],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function wsUrl() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
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
function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolvePromise) => pending.set(id, resolvePromise));
}

async function evaluate(expression, contextId) {
  const result = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
    ...(contextId ? { contextId } : {}),
  });
  if (result.result?.exceptionDetails) {
    throw new Error(JSON.stringify(result.result.exceptionDetails));
  }
  return result.result?.result?.value;
}

await send("Page.enable");
await send("Page.navigate", { url: `${base}/tools/spriteforge` });
await sleep(4000);

// 找到 iframe 的执行上下文
const tree = await send("Page.getFrameTree");
const child = tree.result.frameTree.childFrames?.[0];
if (!child) throw new Error("没找到 iframe —— 页面没挂载成功");
const world = await send("Page.createIsolatedWorld", {
  frameId: child.frame.id,
  worldName: "sprite-check",
});
const contextId = world.result.executionContextId;
console.log("iframe:", child.frame.url);

console.log(
  "初始化:",
  JSON.stringify(
    await evaluate(
      `({ title: document.querySelector(".brand-name")?.textContent?.trim(),
          cell: document.querySelector("#cellSize, .metric-value")?.textContent?.trim() ?? null,
          hasInput: !!document.querySelector("#videoInput"),
          extractLabel: document.querySelector("#extractBtn")?.textContent?.trim() })`,
      contextId,
    ),
  ),
);

// 把真实视频塞进工具的 file input
const objectId = (
  await send("Runtime.evaluate", {
    expression: 'document.querySelector("#videoInput")',
    contextId,
  })
).result.result.objectId;

await send("DOM.setFileInputFiles", { files: [video], objectId });
await sleep(6000);

console.log(
  "导入后:",
  JSON.stringify(
    await evaluate(
      `({ name: document.querySelector("#videoName")?.textContent?.trim(),
          estimate: document.querySelector("#frameEstimate")?.value,
          extractDisabled: document.querySelector("#extractBtn")?.disabled,
          toasts: [...document.querySelectorAll(".toast")].map((n) => n.textContent.trim()) })`,
      contextId,
    ),
  ),
);

// 抽帧
console.log(
  "点击提取:",
  await evaluate(
    `(() => {
       const btn = document.querySelector("#extractBtn");
       if (!btn) return "missing";
       if (btn.disabled) return "disabled";
       btn.click();
       return "ok";
     })()`,
    contextId,
  ),
);

for (let step = 0; step < 12; step += 1) {
  await sleep(1500);
  const state = await evaluate(
    `({ frames: document.querySelector("#frameCount")?.textContent?.trim(),
        grid: document.querySelector("#frameGrid")?.children.length,
        label: document.querySelector("#extractLabel")?.textContent?.trim(),
        sub: document.querySelector("#extractSub")?.textContent?.trim(),
        progressHidden: document.querySelector("#extractProgress")?.hidden,
        track: document.querySelector("#trackBadge")?.textContent?.trim(),
        toasts: [...document.querySelectorAll(".toast")].map((n) => n.textContent.trim()) })`,
    contextId,
  );
  console.log(`t+${(step + 1) * 1.5}s`, JSON.stringify(state));
  if (state.grid > 0 && state.progressHidden) break;
}

const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync("data/ui-spriteforge-run.png", Buffer.from(shot.result.data, "base64"));
console.log("截图: data/ui-spriteforge-run.png");

ws.close();
edge.kill();