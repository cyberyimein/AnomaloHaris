import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { convertRgb565Image } from "./image-codec.js";

function readChunks(png: Buffer): Array<{ name: string; data: Buffer; crc: number }> {
  const chunks: Array<{ name: string; data: Buffer; crc: number }> = [];
  let offset = 8;
  while (offset < png.length) {
    const size = png.readUInt32BE(offset);
    const name = png.toString("ascii", offset + 4, offset + 8);
    const chunkEnd = offset + 12 + size;
    expect(chunkEnd).toBeLessThanOrEqual(png.length);
    const crcData = png.subarray(offset + 4, offset + 8 + size);
    const crc = png.readUInt32BE(offset + 8 + size);
    expect(crc).toBe(crc32ForTest(crcData));
    chunks.push({ name, data: png.subarray(offset + 8, offset + 8 + size), crc });
    offset = chunkEnd;
  }
  expect(offset).toBe(png.length);
  return chunks;
}

function createRawPixels(width: number, height: number, pattern: "solid" | "noise"): Buffer {
  const raw = Buffer.allocUnsafe(width * height * 2);
  for (let pixelIndex = 0; pixelIndex < width * height; pixelIndex += 1) {
    const value = pattern === "solid" ? 0x07e0 : (pixelIndex * 40_503 + 7_919) & 0xffff;
    raw.writeUInt16BE(value, pixelIndex * 2);
  }
  return raw;
}

function expectedPngScanlines(rgb565: Buffer, width: number, height: number): Buffer {
  const scanlines = Buffer.alloc(height * (width * 3 + 1));
  let sourceOffset = 0;
  let targetOffset = 0;
  for (let y = 0; y < height; y += 1) {
    scanlines[targetOffset] = 0;
    targetOffset += 1;
    for (let x = 0; x < width; x += 1) {
      const value = rgb565.readUInt16BE(sourceOffset);
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
  return scanlines;
}

function crc32ForTest(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

describe("RGB565 camera image conversion", () => {
  it("converts a small big-endian RGB565 frame into a standards-compliant PNG", () => {
    const frame = convertRgb565Image({
      mimeType: "application/x-rgb565",
      encoding: "rgb565-be",
      data: Buffer.from([0xf8, 0x00, 0x07, 0xe0]).toString("base64"),
      width: 2,
      height: 1,
      capturedAtMs: 1234,
    });
    const png = Buffer.from(frame.data, "base64");
    const chunks = readChunks(png);
    const imageHeader = chunks.find((chunk) => chunk.name === "IHDR")?.data;
    const imageData = chunks.filter((chunk) => chunk.name === "IDAT").map((chunk) => chunk.data);

    expect(frame).toMatchObject({
      mimeType: "image/png",
      width: 2,
      height: 1,
      capturedAtMs: 1234,
      captureClock: "device_monotonic",
    });
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(imageHeader?.readUInt32BE(0)).toBe(2);
    expect(imageHeader?.readUInt32BE(4)).toBe(1);
    const onePixelHeader = convertRgb565Image({
      mimeType: "application/x-rgb565",
      encoding: "rgb565-be",
      data: Buffer.from([0xf8, 0x00]).toString("base64"),
      width: 1,
      height: 1,
      capturedAtMs: 1234,
    });
    const knownHeaderCrc = readChunks(Buffer.from(onePixelHeader.data, "base64"))
      .find((chunk) => chunk.name === "IHDR")?.crc;
    expect(knownHeaderCrc).toBe(0x907753de);
    expect(inflateSync(Buffer.concat(imageData ?? []))).toEqual(Buffer.from([
      0, 255, 0, 0, 0, 255, 0,
    ]));
  });

  it.each([
    { width: 320, height: 240, pattern: "solid" as const },
    { width: 320, height: 240, pattern: "noise" as const },
    { width: 640, height: 480, pattern: "solid" as const },
    { width: 640, height: 480, pattern: "noise" as const },
  ])("encodes a $width×$height $pattern frame with valid chunks and pixels", ({ width, height, pattern }) => {
    const rawPixels = createRawPixels(width, height, pattern);
    const frame = convertRgb565Image({
      mimeType: "application/x-rgb565",
      encoding: "rgb565-be",
      data: rawPixels.toString("base64"),
      width,
      height,
      capturedAtMs: 1234,
    });
    const png = Buffer.from(frame.data, "base64");
    const chunks = readChunks(png);
    const header = chunks.find((chunk) => chunk.name === "IHDR")?.data;
    const imageData = chunks.filter((chunk) => chunk.name === "IDAT").map((chunk) => chunk.data);

    expect(header?.readUInt32BE(0)).toBe(width);
    expect(header?.readUInt32BE(4)).toBe(height);
    expect(chunks.map((chunk) => chunk.name)).toEqual(["IHDR", "IDAT", "IEND"]);
    expect(inflateSync(Buffer.concat(imageData))).toEqual(expectedPngScanlines(rawPixels, width, height));
  });

  it.each([
    { mimeType: "application/x-rgb565", encoding: "rgb565-le", width: 1, height: 1, data: "AAA=" },
    { mimeType: "application/x-rgb565", encoding: "rgb565-be", width: 1, height: 1, data: "%%%=", },
    { mimeType: "application/x-rgb565", encoding: "rgb565-be", width: 1, height: 1, data: "AAA=", expectedBytes: 2 },
    { mimeType: "application/x-rgb565", encoding: "rgb565-be", width: 1, height: 1, data: "AAA=", capturedAtMs: -1 },
    { mimeType: "application/x-rgb565", encoding: "rgb565-be", width: 641, height: 1, data: "AAA=", },
    { mimeType: "application/x-rgb565", encoding: "rgb565-be", width: 1.5, height: 1, data: "AAA=", },
  ])("rejects malformed or oversized raw frame %#", (image) => {
    expect(() => convertRgb565Image(image)).toThrow();
  });
});
