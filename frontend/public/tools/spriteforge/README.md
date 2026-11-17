# 序列帧工坊（SpriteForge）— 内嵌副本

这里的 `index.html` / `styles.css` / `app.js` 是 [`D:\AI\SpriteForge`](file:///D:/AI/SpriteForge) 的**原样副本**，用来让 MiraForge 直接以静态文件的形式提供这个工具（`/tools/spriteforge/index.html`，由 `/tools/spriteforge` 页面用 iframe 挂载）。

- **不要在这里直接改代码。** 改源头 `D:\AI\SpriteForge`，然后重新同步。
- 同步命令（仓库根目录）：

  ```powershell
  .\tools\sync-spriteforge.ps1           # 复制最新源码
  .\tools\sync-spriteforge.ps1 -Check    # 只比对，不写文件
  ```

- 这个工具不经过 MiraForge 后端，也不调用 ComfyUI：抽帧、抠背景、打图集、导出 ZIP 全部在浏览器里完成，产物走工具自己的下载（`atlas.png` + `atlas.json` + ZIP）。
- 它把偏好存在浏览器的 `localStorage`（key `spriteforge.prefs.v1`），跟随浏览器而不是项目。
