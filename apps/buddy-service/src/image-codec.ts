import { deflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_WIDTH = 640;
const MAX_HEIGHT = 480;

export type Rgb565Image = Record<string, unknown> & {
  mimeType: "application/x-rgb565";
  encoding: "rgb565-be";
  data: string;
  width: number;
  height: number;
  capturedAtMs: number;
};

export type PngImage = Record<string, unknown> & {
  mimeType: "image/png";
  data: string;
  width: number;
  height: number;
  capturedAtMs: number;
  captureClock: "device_monotonic";
};

export function convertRgb565Image(image: Record<string, unknown>): PngImage {
  if (image.mimeType !== "application/x-rgb565" || image.encoding !== "rgb565-be") {
    throw new Error("Unsupported RGB565 image encoding.");
  }

  const width = image.width;
  const height = image.height;
  const capturedAtMs = image.capturedAtMs;
  if (!Number.isSafeInteger(width) || (width as number) < 1 || (width as number) > MAX_WIDTH) {
    throw new Error("RGB565 image width is invalid.");
  }
  if (!Number.isSafeInteger(height) || (height as number) < 1 || (height as number) > MAX_HEIGHT) {
    throw new Error("RGB565 image height is invalid.");
  }
  if (!Number.isSafeInteger(capturedAtMs) || (capturedAtMs as number) < 0) {
    throw new Error("RGB565 image capture time is invalid.");
  }
  const expectedByteLength = (width as number) * (height as number) * 2;
  const expectedBase64Length = Math.ceil(expectedByteLength / 3) * 4;
  if (typeof image.data !== "string"
    || image.data.length !== expectedBase64Length
    || !isCanonicalBase64(image.data)) {
    throw new Error("RGB565 image data is not valid base64.");
  }

  const pixelWidth = width as number;
  const pixelHeight = height as number;
  const rgb565Data = Buffer.from(image.data, "base64");
  if (rgb565Data.length !== expectedByteLength) {
    throw new Error("RGB565 image data length does not match its dimensions.");
  }

  const scanlineLength = pixelWidth * 3 + 1;
  const scanlines = Buffer.allocUnsafe(scanlineLength * pixelHeight);
  let sourceOffset = 0;
  let targetOffset = 0;
  for (let y = 0; y < pixelHeight; y += 1) {
    scanlines[targetOffset] = 0;
    targetOffset += 1;
    for (let x = 0; x < pixelWidth; x += 1) {
      const value = rgb565Data.readUInt16BE(sourceOffset);
      sourceOffset += 2;
      const red5 = (value >>> 11) & 0x1f;
      const green6 = (value >>> 5) & 0x3f;
      const blue5 = value & 0x1f;
      scanlines[targetOffset] = (red5 << 3) | (red5 >>> 2);
      scanlines[targetOffset + 1] = (green6 << 2) | (green6 >>> 4);
      scanlines[targetOffset + 2] = (blue5 << 3) | (blue5 >>> 2);
      targetOffset += 3;
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(pixelWidth, 0);
  header.writeUInt32BE(pixelHeight, 4);
  header[8] = 8;
  header[9] = 2;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  const { encoding: _encoding, ...metadata } = image;
  const png = Buffer.concat([
    PNG_SIGNATURE,
    createPngChunk("IHDR", header),
    createPngChunk("IDAT", deflateSync(scanlines)),
    createPngChunk("IEND", Buffer.alloc(0)),
  ]);

  return {
    ...metadata,
    mimeType: "image/png",
    data: png.toString("base64"),
    width: pixelWidth,
    height: pixelHeight,
    capturedAtMs: capturedAtMs as number,
    captureClock: "device_monotonic",
  };
}

function isCanonicalBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
  return Buffer.from(value, "base64").toString("base64") === value;
}

function createPngChunk(name: string, data: Buffer): Buffer {
  const chunkName = Buffer.from(name, "ascii");
  const chunk = Buffer.allocUnsafe(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  chunkName.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([chunkName, data])), data.length + 8);
  return chunk;
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
