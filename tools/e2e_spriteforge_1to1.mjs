// 端到端验证：原版 SpriteForge 在 MiraForge 里「同文档挂载 + 宿主桥接」后的完整链路。
//   导入按钮 →（本机 / 资产）菜单 → 抽帧 → 轨道 → 播放 → 导出弹层 →「保存到资产」→ ?asset= 重开
// 用法：node tools/e2e_spriteforge_1to1.mjs [--base ...] [--api ...] [--video ...] [--out ...]
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
const shotMenu = resolve(get("menu-out", "data/ui-spriteforge-menu.png"));
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

const shot = async (path) => {
  const png = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(path, Buffer.from(png.data, "base64"));
};

const countAssets = () =>
  evaluate(`fetch("${api}/generations?media=asset&limit=1").then(r => r.json()).then(d => d.total)`);

await send("Page.enable");
await send("Runtime.enable");
await send("DOM.enable");
await send("Page.navigate", { url: `${base}/tools/spriteforge` });
await sleep(2500);

const before = await countAssets();

const mounted = await evaluate(`(() => ({
  brand: (document.querySelector(".sf-app .topbar")?.textContent || "").includes("序列帧工坊"),
  source: !!document.getElementById("videoInput"),
  atlas: !!document.getElementById("atlasInput"),
  exportBtn: !!document.getElementById("exportBtn"),
  track: !!document.getElementById("sequenceList"),
  monitor: !!document.getElementById("previewCanvas"),
  play: !!document.getElementById("playBtn"),
  bridge: typeof window.MiraForgeToolBridge?.chooseSource === "function",
  bridgeSave: typeof window.MiraForgeToolBridge?.saveAsset === "function",
}))()`);

// 1) 原版顶栏的「导入视频」应当先弹来源菜单，而不是直接开文件框
await evaluate(`(() => {
  window.__localPicks = 0;
  const proto = HTMLInputElement.prototype;
  const original = proto.click;
  window.__restoreInputClick = () => { proto.click = original; };
  proto.click = function () { window.__localPicks += 1; return original.call(this); };
  document.getElementById("importVideoBtnTop").click();
  return true;
})()`);
await waitFor(`(() => !!document.querySelector('[data-sf-menu][role="menu"]'))()`, 5000, "来源菜单");
const menuItems = await evaluate(
  `[...document.querySelectorAll('[data-sf-menu][role="menu"] [role="menuitem"]')].map(b => b.textContent.trim())`,
);
await shot(shotMenu);

// 2) 选「从本机上传」→ 应该走到原版的文件框，而不是我们代劳
await evaluate(`(() => {
  const b = [...document.querySelectorAll('[data-sf-menu] [role="menuitem"]')].find(x => x.textContent.includes("从本机"));
  b.click();
  return true;
})()`);
await sleep(400);
const localPicks = await evaluate(`(() => { const n = window.__localPicks; window.__restoreInputClick(); return n; })()`);

// 3) 再走一遍「从资产选」，确认弹出资产选择器（只到打开这一步，不真的挑）
await evaluate(`document.getElementById("importAtlasBtn").click(), true`);
await waitFor(`(() => !!document.querySelector('[data-sf-menu][role="menu"]'))()`, 5000, "图集来源菜单");
await evaluate(`(() => {
  const b = [...document.querySelectorAll('[data-sf-menu] [role="menuitem"]')].find(x => x.textContent.includes("从资产"));
  b.click();
  return true;
})()`);
await waitFor(
  `(() => (document.body.textContent || "").includes("从资产导入图集"))()`,
  8000,
  "资产选择器打开",
);
const pickerOpened = true;
await evaluate(`(() => {
  const b = [...document.querySelectorAll("button")].find(x => x.textContent.trim() === "取消");
  if (b) b.click();
  return true;
})()`);
await sleep(300);

// 4) 「从资产选」真走一遍：挑资产里第一条视频，确认原版真的载入了
await evaluate(`document.getElementById("importVideoBtnTop").click(), true`);
await waitFor(`(() => !!document.querySelector('[data-sf-menu][role="menu"]'))()`, 5000, "第二次来源菜单");
await evaluate(`(() => {
  const b = [...document.querySelectorAll('[data-sf-menu] [role="menuitem"]')].find(x => x.textContent.includes("从资产"));
  b.click();
  return true;
})()`);
await waitFor(`(() => !!document.querySelector("#pickerImages, .grid button img"))()`, 15000, "资产列表");
const assetPick = await evaluate(`(() => {
  const card = [...document.querySelectorAll("button")].find(b => b.querySelector("img") && !b.textContent.includes("取消"));
  if (!card) return null;
  const img = card.querySelector("img");
  card.click();
  return img ? img.getAttribute("src") : "clicked";
})()`);
let assetVideoName = "";
try {
  await waitFor(
    `(() => { const n = document.getElementById("videoName")?.textContent?.trim(); return !!n && n !== "—"; })()`,
    30000,
    "资产视频载入",
  );
  assetVideoName = await evaluate(`document.getElementById("videoName")?.textContent?.trim() ?? ""`);
} catch {
  assetVideoName = "";
}

// 5) 本机文件直接喂进去，继续抽帧流程（资产那条如果没载上，这里保证还能继续）
const doc = await send("DOM.getDocument", { depth: -1 });
const node = await send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: "#videoInput" });
if (!node.nodeId) throw new Error("找不到 #videoInput");
await send("DOM.setFileInputFiles", { nodeId: node.nodeId, files: [videoPath] });

// 等这一次载入真的换成了本地那个视频（不然会在「上一支视频已就绪」的状态下就开始抽帧）
await waitFor(
  `(() => (document.getElementById("videoName")?.textContent || "").includes("video-t2v"))()`,
  20000,
  "本地视频载入",
);
await sleep(900);
await waitFor(
  `(() => { const b = document.getElementById("extractBtn"); const overlay = document.getElementById("progressOverlay"); return !!b && !b.disabled && (!overlay || overlay.hidden); })()`,
  20000,
  "视频就绪",
);
const videoName = await evaluate(`document.getElementById("videoName")?.textContent?.trim() ?? ""`);

await evaluate(`document.getElementById("extractBtn").click(), true`);
await waitFor(
  `(() => { const n = document.querySelectorAll("#frameGrid .frame-card").length; const est = Number(document.getElementById("frameCount")?.textContent?.trim() || 0); return n > 0 && (est === 0 || n >= est); })()`,
  180000,
  "抽帧完成",
);
const frameCount = await evaluate(`document.querySelectorAll("#frameGrid .frame-card").length`);
const estimate = await evaluate(`document.getElementById("frameCount")?.textContent?.trim() ?? ""`);

await evaluate(`(() => {
  const cells = [...document.querySelectorAll("#frameGrid .frame-card")].slice(0, 4);
  for (const cell of cells) cell.click();
  return true;
})()`);
const trackCount = await evaluate(`document.getElementById("trackBadge")?.textContent?.trim() ?? ""`);
const beforePlay = await evaluate(`window.MiraSpriteForge.snapshot()`);
await evaluate(`document.getElementById("playBtn").click(), true`);
await sleep(600);
const duringPlay = await evaluate(`window.MiraSpriteForge.snapshot()`);
await evaluate(`document.getElementById("playBtn").click(), true`);
await sleep(200);
const afterPlay = await evaluate(`window.MiraSpriteForge.snapshot()`);
const played = duringPlay.playing === true && beforePlay.playing === false;
const advanced = duringPlay.current !== beforePlay.current;
await evaluate(`document.getElementById("addToAtlasBtn").click(), true`);
// 追加是异步的：等「已用格子」真的变成 4 再往下走，否则导出会命中「图集为空」
await waitFor(
  `(() => Number((document.getElementById("statUsed")?.textContent || "0").replace(/\D/g, "")) > 0)()`,
  15000,
  "图集追加完成",
);
const atlasSummary = await evaluate(`document.getElementById("statUsed")?.textContent?.trim() ?? ""`);


// 6) 导出弹层里应当多出「保存到资产」，点它把 ZIP 交给 /assets
await evaluate(`document.getElementById("exportBtn").click(), true`);
let modalDiag = null;
try {
  await waitFor(`(() => !!document.getElementById("saveAssetBtn"))()`, 8000, "导出弹层里的保存按钮");
} catch (cause) {
  modalDiag = {
    used: await evaluate(`document.getElementById("statUsed")?.textContent?.trim() ?? ""`),
    toast: await evaluate(`document.getElementById("toastRoot")?.textContent?.trim().slice(0, 120) ?? ""`),
    buttons: await evaluate(
      `[...document.querySelectorAll("#modalRoot button")].map(b => b.id || b.textContent.trim().slice(0, 14))`,
    ),
    bridge: await evaluate(`typeof window.MiraForgeToolBridge?.saveAsset`),
    error: String(cause),
  };
}
const modalFooter = await evaluate(
  `[...document.querySelectorAll('#modalRoot .modal-footer button, #modalRoot button')].map(b => b.textContent.trim()).filter(Boolean).slice(-4)`,
);
await shot(out);

const saveClicked = await evaluate(`(() => {
  const b = document.getElementById("saveAssetBtn");
  if (!b) return false;
  b.click();
  return true;
})()`);

let after = before;
for (let attempt = 0; attempt < 40; attempt += 1) {
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
      menu: { items: menuItems, localPicks, pickerOpened },
      assetPick,
      assetVideoName,
      trackCount,
      videoName,
      estimate,
      frameCount,
      atlasSummary,
      playback: { beforePlay, duringPlay, afterPlay, played, advanced },
      modalFooter,
      modalDiag,
      saveClicked,
      asset: { before, after, newest },
      reimported,
      screenshots: { menu: shotMenu, run: out },
    },
    null,
    2,
  ),
);

ws.close();
edge.kill();
process.exit(0);
