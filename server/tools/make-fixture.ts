// テスト用の音声ファイルを Google TTS で作る（16kHz の WAV）。実在の人の声は使わない。
//   npm run make-fixture -- "日本で一番高い山は？" test/fixtures/fuji.wav
import { resolve } from "node:path";
import { GoogleTts } from "../src/adapters/tts-google.js";
import { loadConfig, loadDotEnv } from "../src/config.js";
import { resample } from "../src/transports/xiaozhi/opus.js";
import { writeWav } from "./wav.js";

loadDotEnv(resolve(process.cwd(), ".env"));
if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = resolve(process.cwd(), process.env.GOOGLE_APPLICATION_CREDENTIALS);
}
const [text, out, voice] = process.argv.slice(2);
if (!text || !out) throw new Error("usage: make-fixture <text> <out.wav> [voice]");
const cfg = loadConfig();
const tts = new GoogleTts({ ...cfg.tts, voice: voice ?? "ja-JP-Neural2-C", speakingRate: 1.0 });
const r = await tts.synthesize(text);
const rate = Number(process.env.RATE ?? 16000);
writeWav(out, resample(r.pcm, r.sampleRate, rate), rate);
console.log(`wrote ${out} (${(r.pcm.length / r.sampleRate).toFixed(2)}s, ${rate}Hz)`);
