// キーなしで端末との往復を確かめる開発用のサーバー（Mac 専用）。
//   - 読み上げ：macOS の say（日本語の声）
//   - 認識：音の大きさで話し始め・話し終わりを判断するだけ（文字にはしない）
//   - 返事：決まった文
//   npm run dev-local            （DEVICE_TRANSPORT=mqtt で MQTT＋UDP）
//   curl -X POST 'http://localhost:8080/dev/remind?in=60&title=テスト'   1分後のリマインダー
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createApp } from "../src/app/server.js";
import { loadConfig } from "../src/config.js";
import type { LanguageModel, LlmEvent, LlmRequest, SpeechToText, SttEvent, SttStream, TextToSpeech } from "../src/core/ports.js";
import { systemClock } from "../src/core/ports.js";
import { dateKey, timeKey, toLocal } from "../src/core/reminders/zoned.js";
import { openDb } from "../src/db/db.js";
import { findDataOffset } from "../src/adapters/tts-google.js";
import { muxOggOpus } from "../src/transports/xiaozhi/ogg.js";
import { OpusEncoder } from "../src/transports/xiaozhi/opus.js";

const run = promisify(execFile);

class SayTts implements TextToSpeech {
  async synthesize(text: string) {
    const dir = mkdtempSync(join(tmpdir(), "say-"));
    try {
      const out = join(dir, "a.wav");
      await run("say", ["-v", "Kyoko", "-r", "190", "-o", out, "--file-format=WAVE", "--data-format=LEI16@24000", text]);
      const buf = readFileSync(out);
      const body = buf.subarray(findDataOffset(buf));
      return { pcm: new Int16Array(body.buffer.slice(body.byteOffset, body.byteOffset + (body.byteLength & ~1))), sampleRate: 24000, characters: text.length };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  async synthesizeOggOpus(text: string) {
    const r = await this.synthesize(text);
    const enc = new OpusEncoder(24000);
    const ogg = muxOggOpus(enc.encodeAll(r.pcm), { inputRate: 24000, frameMs: 60 });
    enc.close();
    return { ogg, characters: r.characters };
  }
}

class EnergyStt implements SpeechToText {
  startStream(): SttStream {
    const queue: SttEvent[] = [];
    let wake: (() => void) | undefined;
    let done = false;
    let speaking = false;
    let loud = 0;
    let quiet = 0;
    let samples = 0;
    const push = (e: SttEvent) => {
      queue.push(e);
      wake?.();
    };
    const finish = () => {
      done = true;
      wake?.();
    };
    return {
      write(pcm) {
        if (done) return;
        samples += pcm.length;
        let sum = 0;
        for (const s of pcm) sum += s * s;
        const rms = Math.sqrt(sum / pcm.length);
        if (!speaking) {
          loud = rms > 600 ? loud + 1 : 0;
          if (loud >= 3) {
            speaking = true;
            push({ type: "speech_start" });
          }
        } else {
          quiet = rms < 400 ? quiet + pcm.length : 0;
          if (quiet > 16000 * 0.8) {
            push({ type: "final", text: `（声を受け取りました：${(samples / 16000).toFixed(1)}秒）` });
            push({ type: "speech_end" });
          }
        }
      },
      end: finish,
      abort: finish,
      events: {
        [Symbol.asyncIterator]: () => ({
          next: async (): Promise<IteratorResult<SttEvent>> => {
            for (;;) {
              const e = queue.shift();
              if (e) return { value: e, done: false };
              if (done) return { value: undefined, done: true };
              await new Promise<void>((r) => (wake = r));
            }
          },
        }),
      },
    };
  }
}

class FixedLlm implements LanguageModel {
  readonly modelName = "fixed";
  async *stream(_req: LlmRequest): AsyncIterable<LlmEvent> {
    const text = "テストの返事です。あなたの声が、サーバーまで届きました。";
    yield { type: "text_delta", text };
    yield {
      type: "done",
      message: { role: "assistant", content: [{ type: "text", text }] },
      stopReason: "end_turn",
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  }
}

const config = loadConfig();
const db = openDb(resolve(config.server.dataDir, "app.db"));
const app = createApp({ config, db, clock: systemClock, stt: new EnergyStt(), tts: new SayTts(), llm: new FixedLlm() });
app.http.post<{ Querystring: { in?: string; title?: string } }>("/dev/remind", async (req, reply) => {
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.ip)) return reply.code(403).send();
  const at = new Date(Math.ceil((Date.now() + Number(req.query.in ?? 60) * 1000) / 60000) * 60000);
  const l = toLocal(at, "Asia/Tokyo");
  const r = app.reminders.create("home", req.query.title ?? "テスト", { kind: "once", date: dateKey(l), time: timeKey(l.hh, l.mm) }, at, new Date());
  return { id: r.id, at: at.toISOString() };
});
// 端末の音量を変える（つながっていればすぐ、そうでなければ次につながったとき）
//   curl -X POST 'http://localhost:8080/dev/volume?v=50'
let pendingVolume: number | undefined;
app.hub.on((e) => {
  if (e.type === "activity" && e.what === "hello" && pendingVolume !== undefined) {
    const v = pendingVolume;
    pendingVolume = undefined;
    app.hub.getMcp(e.deviceId)?.setVolume(v).then(() => console.log(`volume set: ${v}`), (err) => console.log(`volume failed: ${err}`));
  }
});
app.http.post<{ Querystring: { v?: string } }>("/dev/volume", async (req, reply) => {
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.ip)) return reply.code(403).send();
  pendingVolume = Math.max(0, Math.min(100, Number(req.query.v ?? 50)));
  return { pending: pendingVolume };
});
const port = await app.listen();
console.log(`dev-local: port ${port}, transport ${config.server.deviceTransport}`);
