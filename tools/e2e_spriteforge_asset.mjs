// 端到端验证：工坊外壳的「保存到资产」真的把导出产物送进了 /api/v1/assets。
// 用法：node tools/e2e_spriteforge_asset.mjs [--base http://127.0.0.1:3000]
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const get = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};

const base = get("base", "http://127.0.0.1:3000");
const port = Number(get("port", "9477"));
const profile = mkdtempSync(join(tmpdir(), "dsh-sprite-asset-"));
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

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

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
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? "eval 失败");
  }
  return result.result.value;
};

await send("Page.enable");
await send("Runtime.enable");
await send("Page.navigate", { url: `${base}/tools/spriteforge` });
await sleep(3500);

const countAssets = () =>
  evaluate(
    `fetch("http://127.0.0.1:8000/api/v1/generations?media=asset&limit=1").then(r => r.json()).then(d => d.total)`,
  );

const before = await countAssets();
const diag = await evaluate(`(() => {
  const w = document.querySelector("iframe").contentWindow;
  return {
    winFlag: !!w.__miraforgeAnchorPatched,
    protoFlag: !!(w.HTMLAnchorElement && w.HTMLAnchorElement.prototype.__miraforgePatched),
    hasApp: !!w.document.getElementById("videoInput"),
    frames: document.querySelectorAll("iframe").length,
  };
})()`);

// 模拟工坊「导出图集」那一刻：外壳给 downloadBlob 打了钩子，这里直接调它。
// 模拟工坊「导出图集」那一刻：它自己造 blob URL + <a download> + click。
const patched = await evaluate(`(() => {
  const w = document.querySelector("iframe").contentWindow;
  const bytes = new Uint8Array([80, 75, 5, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const blob = new w.Blob([bytes], { type: "application/zip" });
  const url = w.URL.createObjectURL(blob);
  const anchor = w.document.createElement("a");
  anchor.href = url;
  anchor.download = "probe_from_ui.zip";
  w.document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  return "clicked";
})()`);

await sleep(600);
const label = await evaluate(
  `([...document.querySelectorAll("button")].map(b => b.textContent.trim()).find(t => t.includes("保存到资产")) ?? null)`,
);

await evaluate(`(() => {
  const button = [...document.querySelectorAll("button")].find(b => b.textContent.includes("保存到资产"));
  button.click();
  return true;
})()`);
await sleep(3000);

const after = await countAssets();
const note = await evaluate(`document.querySelector("main")?.innerText ?? ""`);

console.log(JSON.stringify({ diag, patched, label, before, after, note: note.slice(0, 220) }, null, 2));

ws.close();
edge.kill();
process.exit(after === before + 1 ? 0 : 1);
