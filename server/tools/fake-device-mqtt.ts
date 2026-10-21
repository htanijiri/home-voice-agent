// MQTT＋UDP の偽の端末で、実際のサーバー（クラウドなど）と会話を往復する（開発用）。
//   npm run fake-device-mqtt -- --base https://<app>.fly.dev --audio test/fixtures/fuji.wav
// 未承認なら承認番号を表示して終わる（承認してからもう一度実行する）
import { parseArgs } from "node:util";
import { OpusEncoder, resample } from "../src/transports/xiaozhi/opus.js";
import { callOta } from "../test/xiaozhi-client.js";
import { FakeMqttDevice } from "../test/xiaozhi-mqtt-client.js";
import { readWav } from "./wav.js";

const { values } = parseArgs({
  options: {
    base: { type: "string", default: "http://127.0.0.1:8080" },
    audio: { type: "string", multiple: true },
    device: { type: "string", default: "02:00:00:00:00:03" },
    client: { type: "string", default: "fake-mqtt-client" },
  },
});
const ota = await callOta(values.base!, values.device!, values.client!);
if (ota.body.activation) {
  console.log(`承認待ち：番号 ${ota.body.activation.code}`);
  process.exit(2);
}
if (!ota.body.mqtt) throw new Error("OTA に mqtt の設定がありません");
const dev = new FakeMqttDevice(ota.body.mqtt);
const t0 = Date.now();
await dev.connect();
console.log(`mqtt connected ${Date.now() - t0}ms (${ota.body.mqtt.endpoint.split(":")[1]})`);
const enc = new OpusEncoder(16000);
for (const [i, file] of (values.audio ?? []).entries()) {
  const { pcm, sampleRate } = readWav(file);
  const p16 = resample(pcm, sampleRate, 16000);
  const withSilence = new Int16Array(p16.length + 24000);
  withSilence.set(p16);
  const before = dev.json.length;
  if (i === 0) {
    await dev.openAudio();
    dev.startListening();
  }
  const audioBefore = dev.audio.length;
  const start = Date.now();
  for (const [k, f] of enc.encodeAll(withSilence).entries()) {
    const wait = start + k * 60 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    dev.sendAudio(f);
  }
  const sentEnd = Date.now();
  const stt = await dev.waitFor((m) => m.type === "stt" && dev.json.indexOf(m) >= before, 20000);
  console.log(`[${i + 1}] stt: ${stt.text}`);
  await dev.waitFor((m) => m.type === "tts" && m.state === "start" && dev.json.indexOf(m) >= before, 20000);
  console.log(`[${i + 1}] tts start (+${Date.now() - sentEnd}ms after audio end)`);
  await dev.waitFor((m) => m.type === "tts" && m.state === "stop" && dev.json.indexOf(m) >= before, 60000);
  const said = dev.json.slice(before).filter((m) => m.state === "sentence_start").map((m) => m.text).join("");
  console.log(`[${i + 1}] reply: ${said}（UDP の音声 ${dev.audio.length - audioBefore} フレーム、送り元 ${[...dev.udpFrom].map((a) => a.replace(/\d+\.\d+\.\d+\.\d+/, "x.x.x.x")).join(" ") || "なし"}）`);
}
dev.goodbye();
await dev.close();
process.exit(0);
