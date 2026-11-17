// 端到端验证：内置版序列帧工坊（无 iframe）能「选视频 → 抽帧 → 保存到资产」。
// 用法：node tools/e2e_spriteforge_native.mjs [--base http://127.0.0.1:3000] [--video data/video-t2v-3s.mp4]
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
const videoPath = resolve(get("video", "data/video-t2v-3s.mp4"));
const out = resolve(get("out", "data/ui-spriteforge-native.png"));
const port = Number(get("port", "9478"));
const profile = mkdtempSync(join(tmpdir(), "dsh-sprite-native-"));

const edge = spawn(
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--autoplay-policy=no-user-gesture-required",
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
    await sleep(400);
  }
  throw new Error(`等待超时：${label}`);
};

await send("Page.enable");
await send("Runtime.enable");
await send("DOM.enable");
await send("Page.navigate", { url: `${base}/tools/spriteforge` });
await sleep(2500);

const countAssets = () =>
  evaluate(
    `fetch("http://127.0.0.1:8000/api/v1/generations?media=asset&limit=1").then(r => r.json()).then(d => d.total)`,
  );

const before = await countAssets();

// 1) 把视频塞进隐藏的 file input（React 的 onChange 会被触发）
const doc = await send("DOM.getDocument", { depth: -1 });
const node = await send("DOM.querySelector", {
  nodeId: doc.root.nodeId,
  selector: 'input[type="file"][accept*="video"]',
});
if (!node.nodeId) throw new Error("页面上找不到视频输入框");
await send("DOM.setFileInputFiles", { nodeId: node.nodeId, files: [videoPath] });

await waitFor(
  `[...document.querySelectorAll("button")].some(b => b.textContent.includes("提取序列帧") && !b.disabled)`,
  20000,
  "视频载入",
);
const loaded = await evaluate(`document.body.innerText.includes("已载入视频") || document.body.innerText.length > 0`);

// 2) 抽帧
await evaluate(`(() => {
  const b = [...document.querySelectorAll("button")].find(x => x.textContent.includes("提取序列帧"));
  b.click();
  return true;
})()`);

await waitFor(
  `document.querySelectorAll('[data-frame]').length > 0`,
  180000,
  "抽帧完成",
);
const frameCount = await evaluate(`document.querySelectorAll('[data-frame]').length`);

// 3) 截图 + 保存到资产
const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(out, Buffer.from(shot.data, "base64"));

await evaluate(`(() => {
  const b = [...document.querySelectorAll("button")].find(x => x.textContent.includes("保存到资产"));
  if (!b || b.disabled) return false;
  b.click();
  return true;
})()`);

let after = before;
for (let attempt = 0; attempt < 25; attempt += 1) {
  await sleep(600);
  after = await countAssets();
  if (after > before) break;
}

const toasts = await evaluate(`[...document.querySelectorAll("div")].map(d => d.textContent).filter(t => t.includes("已保存到资产")).slice(0, 1)`);

console.log(
  JSON.stringify(
    { loaded, frameCount, before, after, toasts, screenshot: out, pass: after === before + 1 && frameCount > 0 },
    null,
    2,
  ),
);

ws.close();
edge.kill();
process.exit(after === before + 1 && frameCount > 0 ? 0 : 1);
