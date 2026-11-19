// 只为抽帧台写的最小 ZIP 打包器：store-only（不压缩）。
// PNG 本身已经是压缩过的，再套一层 deflate 收益不到 1%，直接存省掉一整个压缩库。

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < data.length; index += 1) {
    crc = CRC_TABLE[(crc ^ data[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export type ZipEntry = { name: string; data: Uint8Array };

function dosStamp(date: Date): { time: number; date: number } {
  return {
    time: ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xffff,
    date: (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff,
  };
}

export function createZip(entries: ZipEntry[], now = new Date()): Blob {
  const encoder = new TextEncoder();
  const stamp = dosStamp(now);
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.data);

    const local = new Uint8Array(30 + name.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, stamp.time, true);
    localView.setUint16(12, stamp.date, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, entry.data.length, true);
    localView.setUint32(22, entry.data.length, true);
    localView.setUint16(26, name.length, true);
    localView.setUint16(28, 0, true);
    local.set(name, 30);

    const header = new Uint8Array(46 + name.length);
    const headerView = new DataView(header.buffer);
    headerView.setUint32(0, 0x02014b50, true);
    headerView.setUint16(4, 20, true);
    headerView.setUint16(6, 20, true);
    headerView.setUint16(8, 0, true);
    headerView.setUint16(10, 0, true);
    headerView.setUint16(12, stamp.time, true);
    headerView.setUint16(14, stamp.date, true);
    headerView.setUint32(16, crc, true);
    headerView.setUint32(20, entry.data.length, true);
    headerView.setUint32(24, entry.data.length, true);
    headerView.setUint16(28, name.length, true);
    headerView.setUint16(30, 0, true);
    headerView.setUint16(32, 0, true);
    headerView.setUint16(34, 0, true);
    headerView.setUint16(36, 0, true);
    headerView.setUint32(38, 0, true);
    headerView.setUint32(42, offset, true);
    header.set(name, 46);

    chunks.push(local, entry.data);
    central.push(header);
    offset += local.length + entry.data.length;
  }

  const centralSize = central.reduce((total, part) => total + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);
  endView.setUint16(20, 0, true);

  const parts = [...chunks, ...central, end] as unknown as BlobPart[];
  return new Blob(parts, { type: "application/zip" });
}

export type ZipReadEntry = { name: string; data: Uint8Array };

/**
 * 读回本工具写出的 ZIP（store-only，不压缩）。
 *
 * 帧集是抽帧台自己打的包，所以只需要处理 method 0；碰到 deflate 直接报错，
 * 省掉一整个解压库。
 */
export async function readZip(blob: Blob): Promise<ZipReadEntry[]> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const decoder = new TextDecoder();

  let end = -1;
  for (let offset = bytes.length - 22; offset >= 0 && offset >= bytes.length - 22 - 0xffff; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      end = offset;
      break;
    }
  }
  if (end < 0) throw new Error("不是有效的 ZIP 文件");

  const count = view.getUint16(end + 10, true);
  let cursor = view.getUint32(end + 16, true);
  const entries: ZipReadEntry[] = [];

  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(cursor, true) !== 0x02014b50) throw new Error("ZIP 中央目录损坏");
    const method = view.getUint16(cursor + 10, true);
    const size = view.getUint32(cursor + 20, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    cursor += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/")) continue;
    if (method !== 0) throw new Error("只支持未压缩的 ZIP");
    const localName = view.getUint16(localOffset + 26, true);
    const localExtra = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + localName + localExtra;
    entries.push({ name, data: bytes.slice(start, start + size) });
  }

  return entries;
}
