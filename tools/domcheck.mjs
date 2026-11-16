// 轻量 DOM 断言：用 headless Edge + CDP 打开页面，点击某段文字后 dump 指定区域文本。
// 用法：node tools/domcheck.mjs --url <url> --click <文字> --wait <ms> --json
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const get = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};

const url = get("url");
const click = get("click");
const wait = Number(get("wait", "800"));
const selector = get("selector", "header");
const clickSelector = get("click-selector");
const port = Number(get("port", "9333"));

if (!url) {
  console.error("需要 --url");
  process.exit(1);
}

const profile = mkdtempSync(join(tmpdir(), "dsh-dom-"));
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

async function targets() {
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

const ws = new WebSocket(await targets());
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
  return result.result?.result?.value;
}

await send("Page.enable");
await send("Page.navigate", { url });
await sleep(1500 + wait);

if (clickSelector) {
  const clicked = await evaluate(`(() => {
    const target = document.querySelector(${JSON.stringify(clickSelector)});
    if (!target) return false;
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
    target.click();
    return true;
  })()`);
  console.log("click-selector", clickSelector, clicked ? "ok" : "未找到");
  await sleep(wait);
}

if (click) {
  // 支持用逗号串起多次点击：--click "图片编辑,参考图,从资产选"
  for (const label of click.split(",").map((item) => item.trim()).filter(Boolean)) {
    const clicked = await evaluate(`(() => {
      const want = ${JSON.stringify(label)};
      const nodes = [...document.querySelectorAll("button, a, [role=button]")];
      const target = nodes.find((node) => node.textContent?.trim() === want)
        || nodes.find((node) => node.textContent?.trim().startsWith(want))
        || nodes.find((node) => node.getAttribute("title") === want);
      if (!target) return false;
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
        target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      target.click();
      return true;
    })()`);
    console.log("click", label, clicked ? "ok" : "未找到");
    await sleep(wait);
  }
}

const text = await evaluate(`(() => {
  const node = document.querySelector(${JSON.stringify(selector)}) || document.body;
  return node.innerText;
})()`);

console.log(JSON.stringify({ url, selector, text }, null, 2));
ws.close();
edge.kill();
process.exit(0);
