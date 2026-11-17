// 开发期用的 UI 截图小工具：无头 Edge + CDP，支持先执行一段脚本再截图。
//
// 用法：
//   node tools/screenshot.mjs --url http://127.0.0.1:3000 --out data/ui.png \
//        [--width 1500] [--height 1250] [--click "文字"] [--prompt "文字"] \
//        [--file 路径] [--submit "文字"] [--eval "JS"] [--wait 1500] \
//        [--hover-selector CSS]
//
// 存在理由：这个项目每阶段都要"能运行、能看到"，而 headless 的 --screenshot
// 无法点击、无法等待异步数据，只能靠 CDP 注入。

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const EDGE_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const url = arg("url", "http://127.0.0.1:3000");
const out = resolve(arg("out", "data/ui.png"));
const width = Number(arg("width", "1500"));
const height = Number(arg("height", "1250"));
const click = arg("click", "");
const prompt = arg("prompt", "");
const file = arg("file", "");
const fileSelector = arg("selector", "input[type=file]");
const clickSelector = arg("click-selector", "");
const hoverSelector = arg("hover-selector", "");
const submit = arg("submit", "");
const evaluate = arg("eval", "");
const wait = Number(arg("wait", "2500"));
const port = Number(arg("port", "9222"));

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function findTarget() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((item) => item.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      // 浏览器还没起来
    }
    await sleep(250);
  }
  throw new Error("找不到可调试的页面目标");
}

const edge = spawn(
  EDGE_CANDIDATES.find((path) => existsSync(path)) ?? EDGE_CANDIDATES[0],
  [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--hide-scrollbars",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${resolve(".cache", `edge-${Date.now()}`)}`,
    `--window-size=${width},${height}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);

let socket;
const pending = new Map();
let nextId = 1;

function send(method, params = {}) {
  const id = nextId++;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolvePromise, rejectPromise) => {
    pending.set(id, { resolvePromise, rejectPromise });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        rejectPromise(new Error(`CDP 超时：${method}`));
      }
    }, 30_000);
  });
}

try {
  const wsUrl = await findTarget();
  socket = new WebSocket(wsUrl);
  await new Promise((done, fail) => {
    socket.addEventListener("open", done, { once: true });
    socket.addEventListener("error", fail, { once: true });
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolvePromise, rejectPromise } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) rejectPromise(new Error(message.error.message));
      else resolvePromise(message.result);
    }
  });

  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Page.navigate", { url });
  await sleep(wait);

  // 真实的指针移动：CSS 的 :hover 只认真实输入，派发 mouseover 不算，所以用 CDP 发鼠标移动。
  if (hoverSelector) {
    const box = await send("Runtime.evaluate", {
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(hoverSelector)});
        if (!el) return null;
        el.scrollIntoView({ block: "center" });
        const rect = el.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      })()`,
      returnByValue: true,
    });
    const point = box.result?.value;
    if (point) {
      await send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: point.x,
        y: point.y,
        button: "none",
      });
      console.log(`hover ${hoverSelector}: ${Math.round(point.x)},${Math.round(point.y)}`);
      await sleep(600);
    } else {
      console.log(`hover ${hoverSelector}: not-found`);
    }
  }

  if (click) {
    const expression = `(() => {
      const wanted = ${JSON.stringify(click)};
      const nodes = Array.from(document.querySelectorAll("button, a"));
      const target = nodes.find((node) => (node.textContent || "").includes(wanted));
      if (!target) return "not-found";
      target.click();
      return "clicked";
    })()`;
    const result = await send("Runtime.evaluate", { expression, returnByValue: true });
    console.log(`click ${click}: ${result.result?.value}`);
    await sleep(1200);
  }

  if (clickSelector) {
    const expression = `(() => {
      const target = document.querySelector(${JSON.stringify(clickSelector)});
      if (!target) return "not-found";
      target.click();
      return "clicked";
    })()`;
    const result = await send("Runtime.evaluate", { expression, returnByValue: true });
    console.log(`click ${clickSelector}: ${result.result?.value}`);
    await sleep(1200);
  }

  if (evaluate) {
    const result = await send("Runtime.evaluate", {
      expression: evaluate,
      returnByValue: true,
      awaitPromise: true,
    });
    console.log(`eval: ${JSON.stringify(result.result?.value ?? result.exceptionDetails?.text)}`);
    await sleep(600);
  }

  if (file) {
    await send("DOM.enable");
    const document = await send("DOM.getDocument", { depth: 1 });
    const found = await send("DOM.querySelector", {
      nodeId: document.root.nodeId,
      selector: fileSelector,
    });
    if (!found.nodeId) {
      console.log(`file ${file}: no ${fileSelector} found`);
    } else {
      await send("DOM.setFileInputFiles", {
        files: file
          .split(",")
          .map((item) => resolve(item.trim()))
          .filter(Boolean),
        nodeId: found.nodeId,
      });
      console.log(`file ${file}: attached`);
      await sleep(500);
    }
  }

  if (prompt) {
    const expression = `(() => {
      const wanted = ${JSON.stringify(prompt)};
      const nodes = Array.from(document.querySelectorAll("textarea, input[type=text]"));
      const target = nodes[0];
      if (!target) return "not-found";
      const setter = Object.getOwnPropertyDescriptor(
        target instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype,
        "value",
      ).set;
      setter.call(target, wanted);
      target.dispatchEvent(new Event("input", { bubbles: true }));
      return "typed";
    })()`;
    const result = await send("Runtime.evaluate", { expression, returnByValue: true });
    console.log(`prompt: ${result.result?.value}`);
  }

  if (submit) {
    await sleep(400);
    const expression = `(() => {
      const wanted = ${JSON.stringify(submit)};
      const nodes = Array.from(document.querySelectorAll("button"));
      const target = nodes.find((node) => (node.textContent || "").includes(wanted) && !node.disabled);
      if (!target) return "not-found-or-disabled";
      target.click();
      return "submitted";
    })()`;
    const result = await send("Runtime.evaluate", { expression, returnByValue: true });
    console.log(`submit ${submit}: ${result.result?.value}`);
    await sleep(2000);
  }

  if (evaluate) {
    const result = await send("Runtime.evaluate", {
      expression: evaluate,
      returnByValue: true,
      awaitPromise: true,
    });
    console.log(`eval: ${JSON.stringify(result.result?.value ?? result.exceptionDetails?.text ?? null)}`);
  }

  const shot = await send("Page.captureScreenshot", { format: "png" });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, Buffer.from(shot.data, "base64"));
  console.log(`saved ${out}`);
} finally {
  socket?.close();
  edge.kill();
}
