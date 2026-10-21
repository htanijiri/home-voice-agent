// 16bit・モノラルの WAV の読み書き（開発用のツールで使う）
import { readFileSync, writeFileSync } from "node:fs";
import { findDataOffset } from "../src/adapters/tts-google.js";

export function readWav(path: string): { pcm: Int16Array; sampleRate: number } {
  const buf = readFileSync(path);
  const sampleRate = buf.readUInt32LE(24);
  const off = findDataOffset(buf);
  const body = buf.subarray(off);
  return { pcm: new Int16Array(body.buffer.slice(body.byteOffset, body.byteOffset + (body.byteLength & ~1))), sampleRate };
}

export function writeWav(path: string, pcm: Int16Array, sampleRate: number): void {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([h, data]));
}
