// 端到端验证：图片编辑模式放两张参考图（第 1 张定结构、第 2 张可选），只验证到「可以提交」为止，不真的提交。
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const get = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};

const url = get("url", "http://127.0.0.1:3000/compose");
const out = get("out", "D:/AI/MiraForge/data/ui-edit-two-filled.png");
const port = Number(get("port", "9667"));

const profile = mkdtempSync(join(tmpdir(), "dsh-e2e-edit2-"));
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
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* not ready */
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
  if (result.result?.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails));
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

const pickFromAssets = async (slotText) => {
  const opened = await evaluate(clickText(slotText));
  await sleep(600);
  const chose = await evaluate(clickText("从资产选"));
  await sleep(1500);
  const picked = await evaluate(`(() => {
    const grid = document.querySelector('div[class*="grid-cols-3"]');
    const buttons = grid ? [...grid.querySelectorAll("button")] : [];
    if (buttons.length < 2) return { ok: false, count: buttons.length };
    const index = ${slotText.includes("再") ? 1 : 0};
    const button = buttons[Math.min(index, buttons.length - 1)];
    button.click();
    return { ok: true, count: buttons.length };
  })()`);
  await sleep(1200);
  return { opened, chose, picked };
};

await send("Page.enable");
await send("Page.navigate", { url });
await sleep(3000);

console.log("切到图片编辑:", await evaluate(clickText("图片编辑")));
await sleep(800);

console.log("第 1 张:", JSON.stringify(await pickFromAssets("参考图")));
console.log("第 2 张:", JSON.stringify(await pickFromAssets("再 1 张?")));

const state = await evaluate(`(() => {
  const text = document.querySelector("main")?.innerText ?? "";
  const submit = [...document.querySelectorAll("button")].find((node) =>
    /^编辑出图/.test(node.textContent?.trim() ?? ""),
  );
  const slots = [...document.querySelectorAll("[data-slot]")].length;
  return {
    submitLabel: submit?.textContent?.trim() ?? null,
    submitDisabled: submit?.disabled ?? null,
    slotWrapCount: slots,
    hasSecondHint: text.includes("再 1 张?"),
    textareaPlaceholder: document.querySelector("textarea")?.getAttribute("placeholder") ?? null,
  };
})()`);
console.log("状态:", JSON.stringify(state));

const shot = await send("Page.captureScreenshot", { format: "png" });
const { writeFileSync } = await import("node:fs");
writeFileSync(out, Buffer.from(shot.result.data, "base64"));
console.log("saved", out);

ws.close();
edge.kill();
process.exit(0);
