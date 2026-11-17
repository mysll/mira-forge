// 端到端验证：编辑器导出真的按「画布 × 倍率」出图。
// 用法：node tools/e2e_editor_export.mjs [--image 24] [--tier 256²] [--scale 2×]
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const get = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};

const base = get("base", "http://127.0.0.1:3000");
const imageId = get("image", "24");
const tier = get("tier", "256²");
const scale = get("scale", "2×");
const port = Number(get("port", "9455"));
const downloadDir = get("out", "D:/AI/MiraForge/data/downloads");

rmSync(downloadDir, { recursive: true, force: true });
mkdirSync(downloadDir, { recursive: true });

const profile = mkdtempSync(join(tmpdir(), "dsh-export-"));
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
await send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloadDir });
await send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: downloadDir });
await send("Page.navigate", { url: `${base}/tools/editor?image=${imageId}` });
await sleep(3500);

console.log("点画布档:", await evaluate(clickText(tier)));
await sleep(700);
console.log("点倍率:", await evaluate(clickText(scale)));
await sleep(700);

const label = await evaluate(`(() => {
  const node = [...document.querySelectorAll("button")].find((item) => item.textContent?.includes("导出 PNG"));
  return node ? node.textContent.trim() : "missing";
})()`);
console.log("导出按钮:", label);

const hooked = await evaluate(`(() => {
  window.__exported = null;
  const original = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (blob) => { window.__exported = blob; return original(blob); };
  HTMLAnchorElement.prototype.click = function () {};
  return true;
})()`);
console.log("拦截下载:", hooked);

console.log("触发导出:", await evaluate(clickText("导出 PNG")));
await new Promise((resolve) => setTimeout(resolve, 1500));

const result = await evaluate(`(async () => {
  const blob = window.__exported;
  if (!blob) return { ok: false, reason: "没有生成 blob" };
  const bitmap = new Image();
  const url = URL.createObjectURL(blob);
  await new Promise((resolve, reject) => {
    bitmap.onload = resolve;
    bitmap.onerror = reject;
    bitmap.src = url;
  });
  return { ok: true, bytes: blob.size, type: blob.type, pngSize: bitmap.naturalWidth + "x" + bitmap.naturalHeight };
})()`);
console.log("结果:", JSON.stringify(result), "按钮:", label);

ws.close();
edge.kill();
process.exit(0);