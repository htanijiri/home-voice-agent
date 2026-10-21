import { describe, expect, it } from "vitest";
import { OpusDecoder } from "../src/transports/xiaozhi/opus.js";
import { type DeviceLink, XiaozhiSink } from "../src/transports/xiaozhi/link.js";

function fakeLink() {
  const sent: { at: number; json?: Record<string, unknown>; audio?: Buffer }[] = [];
  const link: DeviceLink = {
    deviceId: "dev-1",
    kind: "mqtt",
    sessionId: "s-1",
    audioOpen: true,
    sendJson: (json) => sent.push({ at: Date.now(), json }),
    sendAudio: (audio) => sent.push({ at: Date.now(), audio }),
    closeAudioChannel() {},
  };
  return { link, sent };
}

/** 24kHz で 60ms（1フレーム）ずつ、大きな音の PCM */
function tone(frames: number): Int16Array {
  const pcm = new Int16Array(1440 * frames);
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 24000));
  return pcm;
}

function peak(pcm: Int16Array): number {
  return pcm.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
}

describe("XiaozhiSink の読み上げの始まり", () => {
  it("tts start のあと、端末が切り替わるのを待ってから、先頭に無音を足して送る", async () => {
    const { link, sent } = fakeLink();
    const sink = new XiaozhiSink(link, { startDelayMs: 80, leadingSilenceMs: 120 });
    const signal = new AbortController().signal;

    sink.ttsStart();
    const startAt = sent[0]!.at;
    sink.sentence("こんにちは");
    await sink.audio(tone(3), 24000, signal);
    sink.sentence("つぎの文です");
    await sink.audio(tone(3), 24000, signal);
    sink.close();

    const audio = sent.filter((m) => m.audio);
    // 最初の文：無音 2 フレーム＋音 3 フレーム。2つめの文には足さない
    expect(audio).toHaveLength(2 + 3 + 3);
    expect(audio[0]!.at - startAt).toBeGreaterThanOrEqual(75);

    const dec = new OpusDecoder();
    const levels = audio.map((m) => peak(dec.decode(m.audio!)));
    dec.close();
    expect(levels[0]).toBeLessThan(200);
    expect(levels[1]).toBeLessThan(200);
    expect(levels[2]).toBeGreaterThan(2000);
  });

  it("待っている間に止められたら、音声を送らない", async () => {
    const { link, sent } = fakeLink();
    const sink = new XiaozhiSink(link, { startDelayMs: 5000, leadingSilenceMs: 60 });
    const ac = new AbortController();

    sink.ttsStart();
    const p = sink.audio(tone(2), 24000, ac.signal);
    setTimeout(() => ac.abort(), 20);
    const t0 = Date.now();
    await p;
    sink.close();

    expect(Date.now() - t0).toBeLessThan(1000);
    expect(sent.filter((m) => m.audio)).toHaveLength(0);
  });
});
