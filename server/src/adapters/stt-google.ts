// Google Speech-to-Text v2 のストリーミング認識のアダプター。SDK を使うのはこのファイルだけ。
import { protos, v2 } from "@google-cloud/speech";
import type { SpeechToText, SttEvent, SttStream } from "../core/ports.js";
import { log } from "../log.js";

export interface GoogleSttConfig {
  projectId: string;
  location: string;
  model: string;
  languageCode: string;
  /** 話し終わりと判断する無音の長さ（秒） */
  speechEndSeconds?: number;
}

class Queue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: ((r: IteratorResult<T>) => void)[] = [];
  private closed = false;
  push(item: T) {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value: item, done: false });
    else this.items.push(item);
  }
  close() {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((r) => this.waiters.push(r));
      },
    };
  }
}

export class GoogleStt implements SpeechToText {
  private readonly client: v2.SpeechClient;

  constructor(private readonly cfg: GoogleSttConfig) {
    const apiEndpoint = cfg.location === "global" ? undefined : `${cfg.location}-speech.googleapis.com`;
    this.client = new v2.SpeechClient(apiEndpoint ? { apiEndpoint } : {});
  }

  startStream(): SttStream {
    const queue = new Queue<SttEvent>();
    const call = this.client._streamingRecognize();
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      queue.close();
    };
    const endSec = this.cfg.speechEndSeconds ?? 0.8;
    call.write({
      recognizer: `projects/${this.cfg.projectId}/locations/${this.cfg.location}/recognizers/_`,
      streamingConfig: {
        config: {
          explicitDecodingConfig: { encoding: "LINEAR16", sampleRateHertz: 16000, audioChannelCount: 1 },
          languageCodes: [this.cfg.languageCode],
          model: this.cfg.model,
          features: { enableAutomaticPunctuation: true },
        },
        streamingFeatures: {
          interimResults: true,
          enableVoiceActivityEvents: true,
          voiceActivityTimeout: {
            speechEndTimeout: { seconds: Math.floor(endSec), nanos: Math.round((endSec % 1) * 1e9) },
          },
        },
      },
    });
    call.on("data", (res: protos.google.cloud.speech.v2.IStreamingRecognizeResponse) => {
      const ev = res.speechEventType;
      // 調べもの用：イベントの種類と結果の数だけ（認識した文章は出さない）
      log.debug("stt data", { ev, results: res.results?.length ?? 0, final: res.results?.some((r) => r.isFinal) ?? false });
      if (ev === "SPEECH_ACTIVITY_BEGIN") queue.push({ type: "speech_start" });
      for (const r of res.results ?? []) {
        const text = r.alternatives?.[0]?.transcript ?? "";
        if (r.isFinal) queue.push({ type: "final", text });
        else if (text) queue.push({ type: "partial", text });
      }
      if (ev === "SPEECH_ACTIVITY_END") queue.push({ type: "speech_end" });
    });
    call.on("error", (err: Error & { code?: number }) => {
      // 自分で止めたとき（CANCELLED）はエラーにしない
      if (!finished && err.code !== 1) queue.push({ type: "error", error: err });
      finish();
    });
    call.on("end", finish);

    let ended = false;
    let written = 0;
    const t0 = Date.now();
    log.debug("stt stream start", { location: this.cfg.location, model: this.cfg.model });
    call.on("close", () => log.debug("stt stream closed", { samples: written, ms: Date.now() - t0 }));
    return {
      write(pcm: Int16Array) {
        if (ended) return;
        written += pcm.length;
        call.write({ audio: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength) });
      },
      end() {
        if (ended) return;
        ended = true;
        call.end();
      },
      abort() {
        ended = true;
        finish();
        call.cancel();
      },
      events: queue,
    };
  }
}
