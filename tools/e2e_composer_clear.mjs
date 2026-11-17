// 端到端验证：图片创作框提交后，提示词与参考图都要清空。
//   塞一张本地参考图 → 写提示词 → 点生成 → 断言 textarea 为空、参考图格子回到「参考图?」
// 用法：node tools/e2e_composer_clear.mjs [--base ...] [--api ...] [--image ...]
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const get = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};

const base = get("base", "http://127.0.0.1:3000");
const api = get("api", "http://127.0.0.1:8000/api/v1");
const imagePath = resolve(get("image", "data/img27.png"));
const port = Number(get("port", "9481"));
const profile = mkdtempSync(join(tmpdir(), "dsh-composer-clear-"));

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

const state = () =>
  evaluate(`(() => {
    const textarea = document.querySelector("textarea");
    const prompt = textarea ? textarea.value : null;
    const thumbs = document.querySelectorAll("[data-slot] img").length;
    const placeholderBack = (document.body.textContent || "").includes("参考图?");
    const button = [...document.querySelectorAll("button")].find((node) => {
      const text = node.textContent?.trim() ?? "";
      return text.startsWith("生成") && !text.startsWith("生成视频");
    });
    return { prompt, thumbs, placeholderBack, button: button?.textContent?.trim() ?? null, disabled: button?.disabled ?? null };
  })()`);

await send("Page.enable");
await send("Runtime.enable");
await send("DOM.enable");
await send("Page.navigate", { url: `${base}/compose` });
await sleep(3000);

const before = await state();

// 生成模式的隐藏 input 带 multiple；编辑模式那个是单选
const doc = await send("DOM.getDocument", { depth: -1 });
const input = await send("DOM.querySelector", {
  nodeId: doc.root.nodeId,
  selector: 'input[type="file"][multiple]',
});
if (!input?.nodeId) throw new Error("没找到参考图输入框");
await send("DOM.setFileInputFiles", { nodeId: input.nodeId, files: [imagePath] });

await waitFor(`document.querySelectorAll("[data-slot] img").length > 0`, 8000, "参考图缩略图出现");
const withRef = await state();

const typed = await evaluate(`(() => {
  const textarea = document.querySelector("textarea");
  if (!textarea) return "missing";
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
  setter.call(textarea, "a quiet test frame for the clear check, cinematic");
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  return textarea.value.length;
})()`);
await sleep(600);

const clicked = await evaluate(`(() => {
  const button = [...document.querySelectorAll("button")].find((node) => {
    const text = node.textContent?.trim() ?? "";
    return text.startsWith("生成") && !text.startsWith("生成视频");
  });
  if (!button) return "missing";
  if (button.disabled) return "disabled";
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
    button.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  }
  button.click();
  return button.textContent?.trim() ?? "ok";
})()`);

await sleep(2600);
const after = await state();

// 顺带确认这一单真的落库了（否则「清空」可能是因为根本没提交）
const newest = await evaluate(`fetch("${api}/generations?media=image&limit=1")
  .then((r) => r.json())
  .then((data) => {
    const item = data.items?.[0];
    return item ? { id: item.id, type: item.generation_type, refs: item.reference_images?.length ?? 0 } : null;
  })`);

console.log(JSON.stringify({ imagePath, before, typed, clicked, withRef, after, newest }, null, 2));

ws.close();
edge.kill();
process.exit(0);
