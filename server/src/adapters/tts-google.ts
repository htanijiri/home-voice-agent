// Google Text-to-Speech のアダプター。SDK を使うのはこのファイルだけ。
import { TextToSpeechClient } from "@google-cloud/text-to-speech";
import type { TextToSpeech, TtsResult } from "../core/ports.js";

export interface GoogleTtsConfig {
  voice: string;
  languageCode: string;
  speakingRate: number;
}

const SAMPLE_RATE = 24000;

export class GoogleTts implements TextToSpeech {
  private readonly client = new TextToSpeechClient();
  constructor(private readonly cfg: GoogleTtsConfig) {}

  private request(text: string, audioEncoding: "LINEAR16" | "OGG_OPUS") {
    return {
      input: { text },
      voice: { languageCode: this.cfg.languageCode, name: this.cfg.voice },
      audioConfig: { audioEncoding, sampleRateHertz: SAMPLE_RATE, speakingRate: this.cfg.speakingRate },
    };
  }

  async synthesize(text: string, opts?: { signal?: AbortSignal }): Promise<TtsResult> {
    const [res] = await this.client.synthesizeSpeech(this.request(text, "LINEAR16"), {
      timeout: 15_000,
      ...(opts?.signal ? { signal: opts.signal } : {}),
    } as object);
    const buf = Buffer.from(res.audioContent as Uint8Array);
    // LINEAR16 は WAV のヘッダー（44 バイト）付きで返る
    const offset = buf.subarray(0, 4).toString("ascii") === "RIFF" ? findDataOffset(buf) : 0;
    const body = buf.subarray(offset);
    const pcm = new Int16Array(body.buffer.slice(body.byteOffset, body.byteOffset + (body.byteLength & ~1)));
    return { pcm, sampleRate: SAMPLE_RATE, characters: [...text].length };
  }

  async synthesizeOggOpus(text: string): Promise<{ ogg: Buffer; characters: number }> {
    const [res] = await this.client.synthesizeSpeech(this.request(text, "OGG_OPUS"), { timeout: 15_000 });
    return { ogg: Buffer.from(res.audioContent as Uint8Array), characters: [...text].length };
  }
}

/** WAV の data チャンクの開始位置 */
export function findDataOffset(buf: Buffer): number {
  let p = 12;
  while (p + 8 <= buf.length) {
    const id = buf.subarray(p, p + 4).toString("ascii");
    const size = buf.readUInt32LE(p + 4);
    if (id === "data") return p + 8;
    p += 8 + size + (size & 1);
  }
  return 44;
}
