/**
 * 最小可用的 ZIP 读写。
 *
 * 写：只做 STORE（不压缩）。图集页是 PNG、JSON 很小，压缩收益有限，
 * 但省掉一个依赖；读：支持 STORE 与 DEFLATE，用浏览器自带的
 * `DecompressionStream("deflate-raw")`（Chrome 103+ / Edge 103+）。
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export type ZipEntry = { name: string; data: Uint8Array };

/** TS 5.9 的 Uint8Array<ArrayBufferLike> 与 BlobPart 不兼容，这里收口一次。 */
const part = (data: Uint8Array): BlobPart => data as unknown as BlobPart;

export const bytesToBlob = (data: Uint8Array, type: string): Blob => new Blob([part(data)], { type });

function dosDateTime(date = new Date()) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() / 2) & 0x1f);
  const day = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
  return { time, day };
}

/** 打一个 STORE 模式的 ZIP。 */
export function createZip(entries: ZipEntry[]): Blob {
  const encoder = new TextEncoder();
  const { time, day } = dosDateTime();
  const chunks: BlobPart[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const local = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true); // UTF-8 文件名
    localView.setUint16(8, 0, true); // STORE
    localView.setUint16(10, time, true);
    localView.setUint16(12, day, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, size, true);
    localView.setUint32(22, size, true);
    localView.setUint16(26, nameBytes.length, true);
    localView.setUint16(28, 0, true);
    local.set(nameBytes, 30);

    const localOffset = offset;
    chunks.push(part(local), part(entry.data));
    offset += local.length + size;

    const record = new Uint8Array(46 + nameBytes.length);
    const recordView = new DataView(record.buffer);
    recordView.setUint32(0, 0x02014b50, true);
    recordView.setUint16(4, 20, true);
    recordView.setUint16(6, 20, true);
    recordView.setUint16(8, 0x0800, true);
    recordView.setUint16(10, 0, true);
    recordView.setUint16(12, time, true);
    recordView.setUint16(14, day, true);
    recordView.setUint32(16, crc, true);
    recordView.setUint32(20, size, true);
    recordView.setUint32(24, size, true);
    recordView.setUint16(28, nameBytes.length, true);
    recordView.setUint16(30, 0, true);
    recordView.setUint16(32, 0, true);
    recordView.setUint16(34, 0, true);
    recordView.setUint16(36, 0, true);
    recordView.setUint32(38, 0, true);
    recordView.setUint32(42, localOffset, true);
    record.set(nameBytes, 46);
    central.push(record);
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const record of central) {
    chunks.push(part(record));
    centralSize += record.length;
  }

  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, centralStart, true);
  chunks.push(end);

  return new Blob(chunks, { type: "application/zip" });
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = bytesToBlob(data, "application/octet-stream").stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** 读出 ZIP 里的全部文件（按名字索引）。 */
export async function readZip(buffer: ArrayBuffer): Promise<Map<string, Uint8Array>> {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const decoder = new TextDecoder();

  // EOCD 在尾部，签名 0x06054b50
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i >= bytes.length - 66_000; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("这个 ZIP 里找不到目录，可能不是标准压缩包");

  const count = view.getUint16(eocd + 10, true);
  let pointer = view.getUint32(eocd + 16, true);
  const files = new Map<string, Uint8Array>();

  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(pointer, true) !== 0x02014b50) break;
    const method = view.getUint16(pointer + 10, true);
    const compressedSize = view.getUint32(pointer + 20, true);
    const nameLength = view.getUint16(pointer + 28, true);
    const extraLength = view.getUint16(pointer + 30, true);
    const commentLength = view.getUint16(pointer + 32, true);
    const localOffset = view.getUint32(pointer + 42, true);
    const name = decoder.decode(bytes.subarray(pointer + 46, pointer + 46 + nameLength));

    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = bytes.subarray(dataStart, dataStart + compressedSize);

    if (!name.endsWith("/")) {
      files.set(name, method === 0 ? raw.slice() : await inflateRaw(raw));
    }
    pointer += 46 + nameLength + extraLength + commentLength;
  }

  return files;
}
