# 序列帧工坊（SpriteForge）—— 接入副本

这三个文件来自 `D:\AI\SpriteForge`（作者自己的项目，纯静态、无构建、无依赖、无网络），
**在本仓库里被就地修改过**，用于适配 MiraForge。上游已经冻结，所以这里就是唯一来源，
不需要再同步。

## 改了什么

1. **启动时机**（`app.js` 末尾）

   原版是 `document.addEventListener('DOMContentLoaded', init)`。我们把它换成暴露
   `window.MiraSpriteForge = { boot, destroy, importFile, snapshot }`，由页面在
   `(0, eval)` 之后再调 `boot()`。

   **不能在这里直接 `init()`**：`init()` 会同步走到 `renderFrameGrid` → `hideFramePeek`，
   而 `framePeekShowTimer` 等 `let` 声明在它后面，直接调用会踩 TDZ
   （`Cannot access 'framePeekShowTimer' before initialization`），表现是「视频载入失败」。
   同时启动块只在 `readyState === 'loading'` 时才挂 `DOMContentLoaded`，否则什么都不做。

2. **导入来源**（`app.js` 的 `requestImport()` + `bindEvents()`）

   顶栏的「导入图集 / 导入视频」和左栏的两个空态按钮，都改成先问
   `window.MiraForgeToolBridge.chooseSource(kind, anchor)`：

   - 返回 `{ action: 'local' }` → 走原版文件选择框；
   - 返回 `{ action: 'asset', file }` → `DataTransfer` 塞进 `#videoInput` / `#atlasInput`，
     再派发一次 `change`，工具自己就能无感接住；
   - 没有宿主桥接 → 直接走文件选择框（把这三个文件单独打开也能用）。

3. **保存到资产**（`app.js` 的 `buildAtlasZip()` / `saveAtlasZip()` + 导出弹层）

   打包逻辑原来是 `exportAtlasZip()` 里连着下载一起做的，拆成 `buildAtlasZip()` 之后，
   「下载 ZIP」和「保存到资产」共用同一个 blob；弹层里只在宿主提供
   `bridge.saveAsset()` 时才多出那个按钮，点击后走 `POST /assets`，不再经手 `<a download>`。

4. **全局监听登记**（`app.js` 的 `onGlobal()` / `hostListeners`）

   文件里所有 `document.addEventListener` / `window.addEventListener` 都换成 `onGlobal(...)`
   （`DOMContentLoaded` 那行除外），`destroy()` 时逐个摘掉，页面卸载不会留悬挂监听。

5. **抠像容差上限**（`app.js` 的 `MAX_KEY_TOLERANCE` + `index.html` 的滑条）

   原版滑到 0–220（欧氏 RGB 距离 0–441）。实测本机的绿幕素材：背景噪声在 24 以内就干净了，
   主体边缘从 ~32 开始，220 把绝大部分色域都摊进滑条、有用区间挤在最前面没法微调。
   现在上限 96（`app.js` 两处 `clamp(..., 0, MAX_KEY_TOLERANCE)` 与 `index.html` 的 `max` 一起改），
   读取 `prefs` 时也继续按 96 收，老用户存的旧大值不会撑破滑条。

6. **连续导入的保护**（`app.js` 的 `videoLoadToken`）

   `loadVideoFile()` 开头 `const token = ++videoLoadToken`，`loadedmetadata` 之后
   若 `token !== videoLoadToken` 就 `revokeObjectURL` 直接返回——连续导入两支视频时，
   晚到的旧一次载入不会覆盖新的那支。

7. **帧集导入**（`app.js` 的 `loadFrameSetFile()` + `syncSequenceUI()` + `frameSourceFor()`）

   抽帧台存下的每一包帧集都是 ZIP，工坊自己没有 ZIP 解析器，所以解包放在宿主：
   `bridge.readFrameSet(file)` 返回 `{ name, fps, frames: [{ index, time, width, height, bitmap }] }`。
   工具接住之后**不再有视频**——`state.sequence` 记住 `{ name, fps, count }`，帧直接被写进
   `state.frames`（缩到最长边 800、转 webp 存 `thumbURL`），抽帧设置整块收起，
   视频位置改成显示首帧封面（`#sequencePoster`），标识牌写「帧集」。

   图集写入原本只认 `els.video`，现在走 `frameSourceFor(frame)`：视频回 `seekVideo` 后的
   `<video>`，帧集回 `getFrameImageAsync(frame)` 的位图；`drawFrameToCell()` 按来源自己的宽高缩放。
   导入菜单多一项「从帧集导入」（只在「导入视频」那组出现），本机 ZIP 与资产里的帧集都走这条路。

   `?frameset=<id>` 深链会直接把那包帧铺进来；它**不绑定素材**，所以保存是新建而不是覆盖。

## 另外两处

- `tool.css` 是 `styles.css` 加了 `.sf-app` 前缀的那一份（`:root`/`html`/`body` → `.sf-app`，
  `body::before` 丢掉），末尾追加了让 `.workspace` 跟随容器高度的覆盖规则。
  只改这一份，不再重新生成。
- `index.html` 除了品牌与结构，只多了三处：`#framesetInput`（隐藏的帧集文件框）、`#sequencePoster`（帧集模式下代替视频显示首帧封面）、以及把「抽帧设置」整块包进 `#extractSettings`（帧集模式下收起）。页面只取它的 `<body>` 标记；宿主也不再叠标题栏，回工具走左侧栏。

## 怎么验证

```powershell
cd D:\AI\MiraForge
node tools/e2e_spriteforge_1to1.mjs     # 菜单 → 本机/资产导入 → 抽帧 → 轨道 → 播放 → 图集 → 导出 → 保存到资产 → ?asset= 重开
```

`MiraSpriteForge.snapshot()` 会返回 `{ duration, videoName, sequence, frames, track, playing, current, atlasPages, atlasCells }`，
排查「帧时间全 0」「轨道没进帧」这类问题时先看它（`sequence` 非空表示这轮是从帧集进来的）。

宿主桥接 `window.MiraForgeToolBridge` 的契约（缺哪个就回退到原版行为）：

| 方法 | 签名 | 用途 |
| --- | --- | --- |
| `chooseSource` | `(kind: "video" \| "atlas", anchor: HTMLElement) => Promise<{action:"local"} \| {action:"asset", file:File} \| {action:"frameset", file:File} \| null>` | 导入前先问「本机 / 资产 / 帧集」 |
| `readFrameSet` | `(file: File) => Promise<{ name:string; fps:number; frames: Array<{index:number; time:number; width:number; height:number; bitmap:ImageBitmap}> }>` | 解开帧集 ZIP |
| `saveAsset` | `(blob: Blob, name: string) => Promise<unknown>` | 导出弹层的「保存到资产 / 保存并覆盖 #id」 |
| `saveLabel` | `() => string` | 保存按钮文案 |
| `saved` | `(payload: {name:string}) => string` | 保存成功后的 toast 文案 |

**播放要在「追加到图集」之前测**：追加会清空轨道，之后按播放自然什么都不动。
