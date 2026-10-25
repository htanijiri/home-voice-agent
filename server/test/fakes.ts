// テスト用の偽の外部サービスと端末
import type {
  Clock,
  LanguageModel,
  LlmEvent,
  LlmRequest,
  SpeechToText,
  SttEvent,
  SttStream,
  TextToSpeech,
  TtsResult,
} from "../src/core/ports.js";
import type { DeviceSink } from "../src/core/voice-session.js";
import type { ChatMessage } from "../src/core/types.js";

export class FakeClock implements Clock {
  constructor(public t = new Date("2026-10-20T10:00:00+09:00")) {}
  now() {
    return new Date(this.t);
  }
  advance(ms: number) {
    this.t = new Date(this.t.getTime() + ms);
  }
}

/** 応答を台本で決める LLM。台本の各要素は、1回の呼び出しで返すメッセージ */
export type ScriptStep =
  | { text: string }
  | { toolUses: { name: string; input: unknown }[]; text?: string; stopReason?: string }
  | { error: Error }
  | { hang: true };

export class FakeLlm implements LanguageModel {
  readonly modelName = "fake";
  readonly requests: LlmRequest[] = [];
  constructor(public script: ScriptStep[]) {}

  async *stream(req: LlmRequest): AsyncIterable<LlmEvent> {
    // 呼ばれた時点の履歴を残す
    this.requests.push({ ...req, messages: structuredClone(req.messages) });
    const step = this.script.shift() ?? { text: "はい。" };
    if ("error" in step) throw step.error;
    if ("hang" in step) {
      await new Promise((_, reject) => req.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
      return;
    }
    const content: ChatMessage["content"] = [];
    if (step.text) {
      // 2文字ずつ流す
      for (let i = 0; i < step.text.length; i += 2) yield { type: "text_delta", text: step.text.slice(i, i + 2) };
      content.push({ type: "text", text: step.text });
    }
    let stopReason = "end_turn";
    if ("toolUses" in step) {
      stopReason = step.stopReason ?? "tool_use";
      step.toolUses.forEach((u, i) => content.push({ type: "tool_use", id: `tu_${i}`, name: u.name, input: u.input }));
    }
    yield {
      type: "done",
      message: { role: "assistant", content },
      stopReason,
      usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  }
}

/** 台本で認識結果を返す STT。write された音声は数えるだけ */
export class FakeStt implements SpeechToText {
  streams: FakeSttStream[] = [];
  /** "silent"：何も返さない。{ afterEnd }：音声の間は何も返さず、end されたら返す（話し始めの合図が遅れる STT） */
  constructor(public script: (SttEvent[] | "silent" | { afterEnd: SttEvent[] })[] = []) {}
  startStream(): SttStream {
    const s = new FakeSttStream(this.script.shift() ?? "silent");
    this.streams.push(s);
    return s;
  }
}

export class FakeSttStream implements SttStream {
  written = 0;
  ended = false;
  aborted = false;
  private queue: SttEvent[] = [];
  private wake?: () => void;
  private done = false;
  constructor(private readonly plan: SttEvent[] | "silent" | { afterEnd: SttEvent[] }) {}

  write(pcm: Int16Array) {
    this.written += pcm.length;
    // 最初の音声で台本のイベントをすべて出す
    if (this.written === pcm.length && Array.isArray(this.plan)) {
      this.queue.push(...this.plan);
      this.wake?.();
    }
  }
  end() {
    if (!this.ended && !Array.isArray(this.plan) && this.plan !== "silent") this.queue.push(...this.plan.afterEnd);
    this.ended = true;
    this.done = true;
    this.wake?.();
  }
  abort() {
    this.aborted = true;
    this.done = true;
    this.wake?.();
  }
  events: AsyncIterable<SttEvent> = {
    [Symbol.asyncIterator]: () => ({
      next: async (): Promise<IteratorResult<SttEvent>> => {
        for (;;) {
          const ev = this.queue.shift();
          if (ev) return { value: ev, done: false };
          if (this.done) return { value: undefined, done: true };
          await new Promise<void>((r) => (this.wake = r));
        }
      },
    }),
  };
}

export class FakeTts implements TextToSpeech {
  readonly texts: string[] = [];
  failWith?: Error;
  /** 1文あたりの音声の長さ（24kHz の標本数） */
  constructor(public samples = 240) {}
  async synthesize(text: string): Promise<TtsResult> {
    if (this.failWith) throw this.failWith;
    this.texts.push(text);
    return { pcm: new Int16Array(this.samples), sampleRate: 24000, characters: text.length };
  }
  async synthesizeOggOpus(text: string) {
    if (this.failWith) throw this.failWith;
    this.texts.push(text);
    return { ogg: Buffer.from("OggS"), characters: text.length };
  }
}

/** ストリーミングの合成を持つ偽の TTS（012）。1文を、決めた長さの塊に分けて返す */
export class FakeStreamingTts extends FakeTts {
  streamed: string[] = [];
  /** 塊の長さ（24kHz の標本数）の並び */
  chunkSizes = [1000, 1000, 500];
  /** ストリーミングを、最初の塊の前に失敗させる */
  streamFailWith?: Error;
  stream(text: string) {
    this.streamed.push(text);
    const sizes = this.chunkSizes;
    const fail = this.streamFailWith;
    return {
      sampleRate: 24000,
      characters: text.length,
      chunks: (async function* () {
        if (fail) throw fail;
        for (const n of sizes) {
          await Promise.resolve();
          yield new Int16Array(n);
        }
      })(),
    };
  }
}

export class RecordingSink implements DeviceSink {
  events: string[] = [];
  stt(text: string) {
    this.events.push(`stt:${text}`);
  }
  emotion(e: string) {
    this.events.push(`emotion:${e}`);
  }
  ttsStart() {
    this.events.push("tts:start");
  }
  sentence(text: string) {
    this.events.push(`sentence:${text}`);
  }
  /** 送られた音声の標本数（塊の列は読み切って数える） */
  samples: number[] = [];
  async audio(pcm: Int16Array | AsyncIterable<Int16Array>) {
    this.events.push("audio");
    let n = 0;
    if (pcm instanceof Int16Array) n = pcm.length;
    else for await (const c of pcm) n += c.length;
    this.samples.push(n);
  }
  ttsStop() {
    this.events.push("tts:stop");
  }
  endConversation() {
    this.events.push("end");
  }
}

export const said = (text: string): SttEvent[] => [
  { type: "speech_start" },
  { type: "final", text },
  { type: "speech_end" },
];

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
