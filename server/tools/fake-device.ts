// 実際のサーバーに、偽の端末として音声ファイルを送って1往復を確かめる。
//   npm run fake-device -- --audio test/fixtures/fuji.wav [--base http://127.0.0.1:8080] [--out data/reply.wav]
// 端末の承認は、ローカルのデータベースを直接使って行う（開発用）。
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/db.js";
import { DevicesRepo } from "../src/db/devices-repo.js";
import { DOWNLINK_RATE, OpusDecoder, OpusEncoder, resample } from "../src/transports/xiaozhi/opus.js";
import { callOta, FakeXiaozhiDevice } from "../test/xiaozhi-client.js";
import { readWav, writeWav } from "./wav.js";
import OpusScript from "opusscript";

const { values } = parseArgs({
  options: {
    audio: { type: "string", multiple: true },
    base: { type: "string", default: "http://127.0.0.1:8080" },
    out: { type: "string", default: "data/fake-device-reply.wav" },
    device: { type: "string", default: "02:00:00:00:00:01" },
    wait: { type: "string", default: "20" },
  },
});
const audios = values.audio ?? [];
if (audios.length === 0) throw new Error("--audio が必要です");

const cfg = loadConfig();
const clientId = "fake-device-client";
let ota = await callOta(values.base!, values.device!, clientId);
if (ota.body.activation) {
  const db = openDb(resolve(cfg.server.dataDir, "app.db"));
  new DevicesRepo(db).approveByCode(ota.body.activation.code, new Date());
  db.close();
  ota = await callOta(values.base!, values.device!, clientId);
}
const ws = ota.body.websocket;
if (!ws) throw new Error(`OTA に websocket がありません: ${JSON.stringify(ota.body)}`);
const dev = new FakeXiaozhiDevice(ws.url, values.device!, ws.token);
const t0 = Date.now();
await dev.connect();
console.log(`connected ${Date.now() - t0}ms`);

const enc = new OpusEncoder(16000);
const replies: Buffer[] = [];
for (const [i, file] of audios.entries()) {
  const { pcm, sampleRate } = readWav(file);
  const pcm16 = resample(pcm, sampleRate, 16000);
  // 話したあとの無音（1.5 秒）を足して、実際の話し方に近づける
  const withSilence = new Int16Array(pcm16.length + 24000);
  withSilence.set(pcm16);
  const frames = enc.encodeAll(withSilence);
  const before = dev.json.length;
  const audioBefore = dev.audio.length;
  if (i === 0) dev.startListening("auto");
  const start = Date.now();
  for (const [k, f] of frames.entries()) {
    const due = start + k * 60;
    const wait = due - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    dev.sendAudio(f);
  }
  const sentEnd = Date.now();
  const stt = await dev.waitFor((m) => m.type === "stt" && dev.json.indexOf(m) >= before, Number(values.wait) * 1000);
  console.log(`[${i + 1}] stt: ${stt.text}  (+${Date.now() - sentEnd}ms after audio end)`);
  const ttsStart = await dev.waitFor((m) => m.type === "tts" && m.state === "start" && dev.json.indexOf(m) >= before);
  console.log(`[${i + 1}] tts start (+${Date.now() - sentEnd}ms)`);
  await dev.waitFor((m) => m.type === "tts" && m.state === "stop" && dev.json.indexOf(m) >= before, 60_000);
  const sentences = dev.json.slice(before).filter((m) => m.state === "sentence_start").map((m) => m.text);
  console.log(`[${i + 1}] reply: ${sentences.join("")}`);
  replies.push(...dev.audio.slice(audioBefore));
  void ttsStart;
}
dev.close();

// 返ってきた音声を WAV にする
const dec = new OpusScript(DOWNLINK_RATE as 24000, 1);
const chunks: Int16Array[] = replies.map((p) => {
  const out = dec.decode(p);
  return new Int16Array(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength));
});
const total = chunks.reduce((n, c) => n + c.length, 0);
const all = new Int16Array(total);
let p = 0;
for (const c of chunks) {
  all.set(c, p);
  p += c.length;
}
writeWav(values.out!, all, DOWNLINK_RATE);
console.log(`reply audio: ${values.out} (${(total / DOWNLINK_RATE).toFixed(2)}s, ${replies.length} frames)`);
void OpusDecoder;
process.exit(0);
