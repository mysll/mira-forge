// 手动复现「内部绿色块抠不掉」的修法，并截图：切「删所有同色」+ 收缩边缘。
// 用法：node tools/shot_editor_cut.mjs [--image 27]
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const get = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const base = get("base", "http://127.0.0.1:3000");
const imageId = get("image", "27");
const out = get("out", "D:/AI/MiraForge/data/ui-editor-fix27.png");
const port = Number(get("port", "9461"));

const profile = mkdtempSync(join(tmpdir(), "dsh-cut-"));
const edge = spawn(
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "--window-size=1400,900", "about:blank"],
  { stdio: "ignore" },
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function wsUrl() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((item) => item.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
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
let messageId = 0;
const pending = new Map();
ws.onmessage = (event) => {
  const payload = JSON.parse(event.data);
  if (payload.id && pending.has(payload.id)) {
    const { resolve, reject } = pending.get(payload.id);
    pending.delete(payload.id);
    if (payload.error) reject(new Error(payload.error.message));
    else resolve(payload.result);
  }
};
const send = (method, params = {}) => {
  messageId += 1;
  const id = messageId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
};

const evaluate = async (expression) => {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result?.value;
};

const clickText = (text) => `(() => {
  const nodes = Array.from(document.querySelectorAll("button, a, [role=button]"));
  const target = nodes.find((node) => (node.textContent || "").trim().includes(${JSON.stringify(text)}));
  if (!target) return "not-found";
  target.click();
  return "clicked";
})()`;

await send("Page.navigate", { url: `${base}/tools/editor?image=${imageId}` });
await sleep(3500);

console.log("切模式:", await evaluate(clickText("删所有同色")));
await sleep(400);
const denoiseSet = await evaluate(`(() => {
  const rows = Array.from(document.querySelectorAll("label, div"));
  const row = rows.find((node) => (node.textContent || "").trim().startsWith("去杂点"));
  const input = row?.querySelector("input[type=range]");
  if (!input) return "not-found";
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  setter.call(input, "2");
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return input.value;
})()`);
console.log("去杂点:", denoiseSet);
await sleep(400);
console.log("抠除:", await evaluate(clickText("抠除背景")));
await sleep(6000);

const state = await evaluate(`(() => {
  const bar = document.querySelector("header ~ *") ;
  const status = Array.from(document.querySelectorAll("div, span")).map((n) => (n.textContent || "").trim()).find((t) => t.startsWith("画布 "));
  const warn = Array.from(document.querySelectorAll("p")).map((p) => p.textContent || "").find((t) => t.includes("封闭背景"));
  return { status, warn };
})()`);
console.log("状态:", JSON.stringify(state));

const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(out, Buffer.from(shot.data, "base64"));
console.log("saved", out);
ws.close();
edge.kill();
process.exit(0);
