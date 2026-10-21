// 音声認識の切り分け用（開発用）：テスト用の音声を、端末と同じく Opus にして戻し、60ms ずつ Google に送る
//   npm run stt-live -- [回数]
import { resolve } from "node:path";
import { GoogleStt } from "../src/adapters/stt-google.js";
import { loadConfig, loadDotEnv } from "../src/config.js";
import { OpusDecoder, OpusEncoder, resample } from "../src/transports/xiaozhi/opus.js";
import { readWav } from "./wav.js";

loadDotEnv(resolve(".env"));
process.env.GOOGLE_APPLICATION_CREDENTIALS = resolve(process.env.GOOGLE_APPLICATION_CREDENTIALS!);
const cfg = loadConfig();
const stt = new GoogleStt({ projectId: process.env.GOOGLE_CLOUD_PROJECT!, ...cfg.stt });
const { pcm, sampleRate } = readWav("test/fixtures/fuji.wav");
const enc = new OpusEncoder(16000);
const dec = new OpusDecoder();
const frames = enc.encodeAll(resample(pcm, sampleRate, 16000)).map((f) => dec.decode(f));
const silence = new Int16Array(960);
for (let round = 1; round <= Number(process.argv[2] ?? 2); round++) {
  const s = stt.startStream();
  const t0 = Date.now();
  const ev: string[] = [];
  const done = (async () => {
    for await (const e of s.events) ev.push(`${Date.now() - t0}ms:${e.type}${"text" in e ? `:${e.text}` : ""}${e.type === "error" ? `:${e.error.message.slice(0, 100)}` : ""}`);
  })();
  for (const f of [...frames, ...Array(40).fill(silence)]) {
    s.write(f);
    await new Promise((r) => setTimeout(r, 60));
  }
  s.end();
  await Promise.race([done, new Promise((r) => setTimeout(r, 5000))]);
  console.log(`round ${round}:`, ev.filter((e) => !e.includes("partial")).join(" | ") || "(イベントなし)");
}
process.exit(0);
