// Google の音声合成の声の一覧と、音声認識（ストリーミング）のモデルごとの結果を確かめる（開発用）
//   npm run check-google
import { resolve } from "node:path";

const { loadConfig, loadDotEnv } = await import("../src/config.js");
loadDotEnv(resolve(".env"));
process.env.GOOGLE_APPLICATION_CREDENTIALS = resolve(process.env.GOOGLE_APPLICATION_CREDENTIALS!);
const { TextToSpeechClient } = await import("@google-cloud/text-to-speech");
const tts = new TextToSpeechClient();
const [v] = await tts.listVoices({ languageCode: "ja-JP" });
const names = (v.voices ?? []).map((x) => `${x.name}(${x.ssmlGender})`).filter((n) => /Chirp3/.test(n));
console.log("Chirp3 ja-JP voices:", names.length, names.slice(0, 30).join(" "));
const { GoogleStt } = await import("../src/adapters/stt-google.js");
const { readWav } = await import("./wav.js");
const cfg = loadConfig();
for (const [location, model] of [[cfg.stt.location, cfg.stt.model], ["global", "short"]] as [string, string][]) {
  const stt = new GoogleStt({ projectId: process.env.GOOGLE_CLOUD_PROJECT!, location, model, languageCode: "ja-JP" });
  const { pcm } = readWav("test/fixtures/fuji.wav");
  const s = stt.startStream();
  const t0 = Date.now();
  const events: string[] = [];
  const done = (async () => { for await (const e of s.events) events.push(`${Date.now() - t0}ms:${e.type}${"text" in e ? ":" + e.text : ""}${e.type === "error" ? ":" + e.error.message.slice(0, 120) : ""}`); })();
  const withSilence = new Int16Array(pcm.length + 16000 * 2); withSilence.set(pcm);
  for (let i = 0; i < withSilence.length; i += 960) { s.write(withSilence.subarray(i, i + 960)); await new Promise((r) => setTimeout(r, 60)); if (events.some((e) => e.includes("speech_end"))) break; }
  s.end();
  await Promise.race([done, new Promise((r) => setTimeout(r, 8000))]);
  console.log(`[${location}/${model}]`, events.filter((e) => !e.includes("partial")).join(" | "));
}
process.exit(0);
