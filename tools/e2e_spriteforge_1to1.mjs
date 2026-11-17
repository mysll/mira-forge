// 端到端验证：原版 SpriteForge 在 MiraForge 里「同文档挂载」后的完整链路。
//   选视频 → 抽帧 → 点缩略图进轨道 → 播放预览 → 导出 ZIP → 保存到资产 → 用 ?asset= 重新导入
// 用法：node tools/e2e_spriteforge_1to1.mjs [--base http://127.0.0.1:3000] [--video data/video-t2v-3s.mp4]
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
const api = get("api", "http://127.0.0.1:8000/api/v1");
const videoPath = resolve(get("video", "data/video-t2v-3s.mp4"));
const out = resolve(get("out", "data/ui-spriteforge-1to1-run.png"));
const port = Number(get("port", "9479"));
const profile = mkdtempSync(join(tmpdir(), "dsh-sprite-1to1-"));

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

const countAssets = () =>
  evaluate(`fetch("${api}/generations?media=asset&limit=1").then(r => r.json()).then(d => d.total)`);

await send("Page.enable");
await send("Runtime.enable");
await send("DOM.enable");
await send("Page.navigate", { url: `${base}/tools/spriteforge` });
await sleep(2500);

const before = await countAssets();

// 工坊是否真的挂载起来了（原版顶栏 + 三个面板 + 轨道）
const mounted = await evaluate(`(() => ({
  brand: !!document.querySelector(".sf-app .topbar .brand")
    || document.querySelector(".sf-app .topbar")?.textContent.includes("序列帧工坊") || false,
  source: !!document.getElementById("videoInput"),
  atlas: !!document.getElementById("atlasInput"),
  exportBtn: !!document.getElementById("exportBtn"),
  track: !!document.getElementById("sequenceList"),
  monitor: !!document.getElementById("previewCanvas"),
  play: !!document.getElementById("playBtn"),
}))()`);

// 1) 载入视频
const doc = await send("DOM.getDocument", { depth: -1 });
const node = await send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: "#videoInput" });
if (!node.nodeId) throw new Error("找不到 #videoInput");
await send("DOM.setFileInputFiles", { nodeId: node.nodeId, files: [videoPath] });

await waitFor(`(() => { const b = document.getElementById("extractBtn"); return !!b && !b.disabled; })()`, 20000, "视频载入");
const videoName = await evaluate(`document.getElementById("videoName")?.textContent?.trim() ?? ""`);

// 2) 抽帧
await evaluate(`document.getElementById("extractBtn").click(), true`);
await waitFor(
  `(() => { const n = document.querySelectorAll("#frameGrid .frame-card").length; const est = Number(document.getElementById("frameCount")?.textContent?.trim() || 0); return n > 0 && (est === 0 || n >= est); })()`,
  180000,
  "抽帧完成",
);
const frameCount = await evaluate(`document.querySelectorAll("#frameGrid .frame-card").length`);
const estimate = await evaluate(`document.getElementById("frameCount")?.textContent?.trim() ?? ""`);

// 3) 前 4 帧进轨道，再追加成图集
await evaluate(`(() => {
  const cells = [...document.querySelectorAll("#frameGrid .frame-card")].slice(0, 4);
  for (const cell of cells) cell.click();
  return true;
})()`);
const trackCount = await evaluate(`document.querySelectorAll("#sequenceList > *").length`);
await evaluate(`document.getElementById("addToAtlasBtn").click(), true`);
const atlasSummary = await evaluate(`document.getElementById("statUsed")?.textContent?.trim() ?? ""`);

// 4) 播放预览（时间码要往前走）
const beforeTime = await evaluate(`document.getElementById("timecode")?.textContent?.trim() ?? ""`);
await evaluate(`document.getElementById("playBtn").click(), true`);
await sleep(900);
const duringTime = await evaluate(`document.getElementById("timecode")?.textContent?.trim() ?? ""`);
await evaluate(`document.getElementById("playBtn").click(), true`);

// 5) 导出 ZIP：点导出图集 → 弹层里点下载 ZIP，把 <a download> 的点击折下来
const exported = await evaluate(`(async () => {
  return await new Promise((resolve) => {
    const proto = HTMLAnchorElement.prototype;
    const original = proto.click;
    const timer = setTimeout(() => { proto.click = original; resolve({ ok: false, reason: "timeout" }); }, 15000);
    proto.click = function () {
      const href = this.href;
      if (!href || !href.startsWith("blob:")) return original.call(this);
      proto.click = original;
      clearTimeout(timer);
      fetch(href).then(r => r.blob()).then(b => resolve({ ok: true, bytes: b.size, type: b.type, name: this.download }))
        .catch(e => resolve({ ok: false, reason: String(e) }));
    };
    document.getElementById("exportBtn").click();
    setTimeout(() => {
      const zip = document.getElementById("downloadZipBtn");
      if (zip) zip.click();
    }, 80);
  });
})()`);

const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(out, Buffer.from(shot.data, "base64"));

// 6) 保存到资产
await evaluate(`(() => {
  const b = [...document.querySelectorAll("button")].find(x => x.textContent.trim().startsWith("保存到资产"));
  if (!b || b.disabled) return false;
  b.click();
  return true;
})()`);

let after = before;
for (let attempt = 0; attempt < 30; attempt += 1) {
  await sleep(500);
  after = await countAssets();
  if (after > before) break;
}

// 7) 用 ?asset=<id> 重新打开，确认图集能拆回来
const newest = await evaluate(
  `fetch("${api}/generations?media=asset&limit=1").then(r => r.json()).then(d => d.items?.[0]?.images?.[0]?.id ?? null)`,
);
let reimported = null;
if (newest) {
  await send("Page.navigate", { url: `${base}/tools/spriteforge?asset=${newest}` });
  await sleep(1200);
  try {
    await waitFor(`(() => !!document.getElementById("exportBtn"))()`, 20000, "工坊二次挂载");
    await waitFor(
      `(() => { const n = Number((document.getElementById("statUsed")?.textContent || "0").replace(/\\D/g, "")); return n > 0; })()`,
      60000,
      "图集导入",
    );
    reimported = {
      used: await evaluate(`document.getElementById("statUsed")?.textContent?.trim() ?? ""`),
      pages: await evaluate(`document.getElementById("statPages")?.textContent?.trim() ?? ""`),
      badge: await evaluate(`document.getElementById("atlasTabBadge")?.textContent?.trim() ?? ""`),
      pageList: await evaluate(`document.querySelectorAll("#pageList > *").length`),
      toast: await evaluate(`document.getElementById("toastRoot")?.textContent?.trim().slice(0, 80) ?? ""`),
    };
  } catch (cause) {
    reimported = { error: String(cause) };
  }
}

console.log(
  JSON.stringify(
    {
      mounted,
      videoName,
      estimate,
      frameCount,
      trackCount,
      time: { beforeTime, duringTime, moved: beforeTime !== duringTime },
      exported,
      asset: { before, after, newest },
      reimported,
      screenshot: out,
    },
    null,
    2,
  ),
);

ws.close();
edge.kill();
process.exit(0);
