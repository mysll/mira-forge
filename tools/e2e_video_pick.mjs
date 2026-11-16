// 端到端验证：视频首帧从资产库挑选 → 提交 → 库里应出现一条 image_to_video。
// 用法：node tools/e2e_video_pick.mjs [--url http://127.0.0.1:3000/video]
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const get = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};

const url = get("url", "http://127.0.0.1:3000/video");
const api = get("api", "http://127.0.0.1:8000/api/v1");
const port = Number(get("port", "9444"));
const prompt = get("prompt", "the same ceramic bowl, now slowly rotating on a turntable, soft studio light");

const profile = mkdtempSync(join(tmpdir(), "dsh-e2e-"));
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function wsUrl() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await response.json();
      const page = list.find((item) => item.type === "page");
      if (page?.webSocketDebuggerUrl) {
        return page.webSocketDebuggerUrl;
      }
    } catch {
      /* 还没起来 */
    }
    await sleep(200);
  }
  throw new Error("连不上调试端口");
}

const ws = new WebSocket(await wsUrl());
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
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
  return new Promise((resolve) => pending.set(id, resolve));
}

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.result?.exceptionDetails) {
    throw new Error(JSON.stringify(result.result.exceptionDetails));
  }
  return result.result?.result?.value;
}

const clickText = (text) => `(() => {
  const want = ${JSON.stringify(text)};
  const nodes = [...document.querySelectorAll("button, a, [role=button]")];
  const target = nodes.find((node) => node.textContent?.trim() === want)
    || nodes.find((node) => node.textContent?.trim().startsWith(want));
  if (!target) return "missing";
  if (target.disabled) return "disabled";
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  }
  target.click();
  return "ok";
})()`;

await send("Page.enable");
await send("Page.navigate", { url });
await sleep(3000);

const before = await (await fetch(`${api}/generations?media=video&limit=1`)).json();
console.log("视频批次（提交前）:", before.total);

console.log("点首帧:", await evaluate(clickText("首帧")));
await sleep(1500);

const picked = await evaluate(`(() => {
  const grid = document.querySelector('div[class*="grid-cols-3"]');
  const button = grid?.querySelector("button");
  if (!button) return { ok: false, reason: "资产网格是空的" };
  const label = button.textContent?.trim();
  button.click();
  return { ok: true, label };
})()`);
console.log("挑选资产图片:", JSON.stringify(picked));
await sleep(1200);

const filled = await evaluate(`(() => {
  const area = document.querySelector("textarea");
  if (!area) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
  setter.call(area, ${JSON.stringify(prompt)});
  area.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
})()`);
console.log("写入提示词:", filled);
await sleep(600);

console.log("点生成:", await evaluate(clickText("生成视频")));
await sleep(2500);

const after = await (await fetch(`${api}/generations?media=video&limit=3`)).json();
const newest = after.items?.[0];
console.log(
  "新批次:",
  newest
    ? JSON.stringify({
        id: newest.id,
        type: newest.generation_type,
        status: newest.status,
        frames: newest.reference_images?.length ?? 0,
        prompt: newest.prompt?.slice(0, 32),
        task: newest.tasks?.[0]?.id,
      })
    : "没有新批次",
);

ws.close();
edge.kill();
process.exit(0);
