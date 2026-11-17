/**
 * 序列帧 → 图集（以及反向：图集 → 帧）。
 *
 * JSON 结构与 SpriteForge v1 兼容（`version/generator/coordinateSystem/atlas/pages/sequences`），
 * 所以我们导出的 zip 既能被本工具读回，也能被 SpriteForge 原工具读。
 */

export type AtlasConfig = {
  cols: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
  scale: number;
};

export type AtlasPlacement = {
  index: number;
  page: number;
  row: number;
  col: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type AtlasPage = { canvas: HTMLCanvasElement; usedCells: number };

export type PackedAtlas = { pages: AtlasPage[]; placements: AtlasPlacement[] };

/** 一页能放多少格 */
export function capacityOf(config: Pick<AtlasConfig, "cols" | "rows">): number {
  return Math.max(1, Math.floor(config.cols) * Math.floor(config.rows));
}

/**
 * 把帧按「从左到右、从上到下」填进若干页。
 * 单元格内按 `scale` 等比缩放并居中，不裁切、不拉伸。
 */
export function packFrames(frames: HTMLCanvasElement[], config: AtlasConfig): PackedAtlas {
  const cols = Math.max(1, Math.floor(config.cols));
  const rows = Math.max(1, Math.floor(config.rows));
  const cellWidth = Math.max(1, Math.floor(config.cellWidth));
  const cellHeight = Math.max(1, Math.floor(config.cellHeight));
  const perPage = cols * rows;
  const pageCount = Math.max(1, Math.ceil(frames.length / perPage));

  const pages: AtlasPage[] = [];
  const placements: AtlasPlacement[] = [];

  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const canvas = document.createElement("canvas");
    canvas.width = cols * cellWidth;
    canvas.height = rows * cellHeight;
    const context = canvas.getContext("2d");
    if (context) {
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
    }
    pages.push({ canvas, usedCells: 0 });
  }

  frames.forEach((frame, index) => {
    const pageIndex = Math.floor(index / perPage);
    const slot = index % perPage;
    const row = Math.floor(slot / cols);
    const col = slot % cols;
    const x = col * cellWidth;
    const y = row * cellHeight;
    const context = pages[pageIndex].canvas.getContext("2d");
    if (context) {
      const fit = Math.min((cellWidth * config.scale) / frame.width, (cellHeight * config.scale) / frame.height);
      const width = Math.max(1, Math.round(frame.width * fit));
      const height = Math.max(1, Math.round(frame.height * fit));
      const dx = x + Math.round((cellWidth - width) / 2);
      const dy = y + Math.round((cellHeight - height) / 2);
      context.drawImage(frame, dx, dy, width, height);
    }
    pages[pageIndex].usedCells += 1;
    placements.push({
      index,
      page: pageIndex + 1,
      row: row + 1,
      col: col + 1,
      x,
      y,
      width: cellWidth,
      height: cellHeight,
    });
  });

  return { pages, placements };
}

export function buildAtlasJson(options: {
  name: string;
  config: AtlasConfig;
  packed: PackedAtlas;
  fps: number;
  times: number[];
}): string {
  const { name, config, packed, fps, times } = options;
  const sequences = packed.pages.map((_, pageIndex) => {
    const frames = packed.placements
      .filter((placement) => placement.page === pageIndex + 1)
      .map((placement) => ({
        index: placement.index,
        sourceIndex: placement.index,
        time: Number(times[placement.index] ?? 0),
        page: placement.page,
        row: placement.row,
        col: placement.col,
        startRow: placement.row,
        startCol: placement.col,
        endRow: placement.row,
        endCol: placement.col,
        x: placement.x,
        y: placement.y,
        width: placement.width,
        height: placement.height,
      }));
    return {
      name: `${name}_${String(pageIndex + 1).padStart(2, "0")}`,
      fps,
      frameCount: frames.length,
      frames,
      startRow: frames[0]?.row ?? 1,
      startCol: frames[0]?.col ?? 1,
      endRow: frames[frames.length - 1]?.row ?? 1,
      endCol: frames[frames.length - 1]?.col ?? 1,
    };
  });

  return JSON.stringify(
    {
      version: 1,
      generator: "SpriteForge / 序列帧工坊",
      exportedAt: new Date().toISOString(),
      coordinateSystem: { origin: "top-left", rowBase: 1, colBase: 1, units: "pixels" },
      atlas: {
        name,
        width: packed.pages[0]?.canvas.width ?? 0,
        height: packed.pages[0]?.canvas.height ?? 0,
        rows: config.rows,
        cols: config.cols,
        cellWidth: config.cellWidth,
        cellHeight: config.cellHeight,
        pageCount: packed.pages.length,
        usedCells: packed.placements.length,
        capacity: packed.pages.length * capacityOf(config),
      },
      pages: packed.pages.map((page, index) => ({
        index: index + 1,
        name: `${name}_${String(index + 1).padStart(2, "0")}.png`,
        width: page.canvas.width,
        height: page.canvas.height,
        usedCells: page.usedCells,
      })),
      sequences,
    },
    null,
    2,
  );
}

export type ParsedAtlasFrame = { page: number; x: number; y: number; width: number; height: number; time: number };

export type ParsedAtlas = {
  name: string;
  pageCount: number;
  pageWidth: number;
  pageHeight: number;
  frames: ParsedAtlasFrame[];
};

type RawFrame = {
  page?: number;
  row?: number;
  col?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  time?: number;
};

/**
 * 读回图集 JSON。只依赖 `atlas` + `sequences` 两段：
 * 老工具（SpriteForge）给 row/col + 基准 1，本工具给 x/y，
 * 两者都换算成页面内的像素矩形。
 */
export function parseAtlasJson(text: string): ParsedAtlas {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("这不是一个 JSON 文件");
  }
  const doc = data as {
    atlas?: { name?: string; width?: number; height?: number; cellWidth?: number; cellHeight?: number; cols?: number; rows?: number; pageCount?: number };
    pages?: { index?: number }[];
    sequences?: { name?: string; frames?: RawFrame[] }[];
  };
  if (!doc.atlas || !Array.isArray(doc.sequences)) {
    throw new Error("JSON 格式不符合图集结构（缺少 atlas / pages / sequences）");
  }

  const cellWidth = Math.max(1, Math.floor(doc.atlas.cellWidth ?? doc.atlas.width ?? 1));
  const cellHeight = Math.max(1, Math.floor(doc.atlas.cellHeight ?? doc.atlas.height ?? 1));
  const pageCount = Math.max(1, Math.floor(doc.atlas.pageCount ?? doc.pages?.length ?? 1));

  const frames: ParsedAtlasFrame[] = [];
  for (const sequence of doc.sequences) {
    for (const frame of sequence.frames ?? []) {
      const page = Math.max(1, Math.floor(frame.page ?? 1));
      const x = Number.isFinite(frame.x) ? Number(frame.x) : (Math.max(1, Math.floor(frame.col ?? 1)) - 1) * cellWidth;
      const y = Number.isFinite(frame.y) ? Number(frame.y) : (Math.max(1, Math.floor(frame.row ?? 1)) - 1) * cellHeight;
      frames.push({
        page,
        x,
        y,
        width: Math.max(1, Math.floor(frame.width ?? cellWidth)),
        height: Math.max(1, Math.floor(frame.height ?? cellHeight)),
        time: Number(frame.time ?? 0),
      });
    }
  }

  if (frames.length === 0) {
    throw new Error("这个图集里没有任何帧");
  }

  return {
    name: doc.atlas.name || "导入的图集",
    pageCount,
    pageWidth: Math.max(1, Math.floor(doc.atlas.width ?? cellWidth)),
    pageHeight: Math.max(1, Math.floor(doc.atlas.height ?? cellHeight)),
    frames,
  };
}
