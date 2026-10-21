import { describe, expect, it } from "vitest";
import { demuxOggOpus, muxOggOpus } from "../src/transports/xiaozhi/ogg.js";
import { OpusDecoder, OpusEncoder } from "../src/transports/xiaozhi/opus.js";

describe("Ogg Opus", () => {
  it("Opus のフレームをまとめて、分解すると同じフレームに戻る（CRC も正しい）", () => {
    const enc = new OpusEncoder(24000);
    const pcm = new Int16Array(24000).map((_, i) => Math.round(Math.sin(i / 10) * 8000));
    const frames = enc.encodeAll(pcm);
    enc.close();
    const ogg = muxOggOpus(frames, { inputRate: 24000, frameMs: 60 });
    expect(ogg.subarray(0, 4).toString()).toBe("OggS");
    const d = demuxOggOpus(ogg);
    expect(d.crcOk).toBe(true);
    expect(d.head.subarray(0, 8).toString()).toBe("OpusHead");
    expect(d.frames).toHaveLength(frames.length);
    expect(Buffer.compare(d.frames[3]!, frames[3]!)).toBe(0);
  });
  it("255 バイト以上のフレームも扱える", () => {
    const big = Buffer.alloc(700, 1);
    const d = demuxOggOpus(muxOggOpus([big, Buffer.from([1, 2, 3])], { inputRate: 24000, frameMs: 60 }));
    expect(d.frames[0]!.length).toBe(700);
    expect(d.frames[1]!.length).toBe(3);
  });
  void OpusDecoder;
});
