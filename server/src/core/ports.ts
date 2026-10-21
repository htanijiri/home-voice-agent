// 外部サービスと時計のインターフェース。実装は src/adapters/ に置き、テストでは偽物に差し替える。
import type { ChatMessage, LlmUsage, ToolDefinition } from "./types.js";

/** 音声認識の結果のイベント */
export type SttEvent =
  | { type: "speech_start" }
  | { type: "partial"; text: string }
  | { type: "final"; text: string }
  | { type: "speech_end" }
  | { type: "error"; error: Error };

export interface SttStream {
  /** 16kHz・モノラルの PCM を渡す */
  write(pcm: Int16Array): void;
  /** 入力の終わり。残りの結果を出して events を閉じる */
  end(): void;
  /** 途中でやめる */
  abort(): void;
  events: AsyncIterable<SttEvent>;
}

export interface SpeechToText {
  startStream(): SttStream;
}

export interface TtsResult {
  /** 24kHz・モノラルの PCM */
  pcm: Int16Array;
  sampleRate: number;
  characters: number;
}

export interface TextToSpeech {
  synthesize(text: string, opts?: { signal?: AbortSignal }): Promise<TtsResult>;
  /** 通知用。Ogg Opus のファイルを返す */
  synthesizeOggOpus(text: string): Promise<{ ogg: Buffer; characters: number }>;
}

export type LlmEvent =
  | { type: "text_delta"; text: string }
  | { type: "done"; message: ChatMessage; stopReason: string; usage: LlmUsage };

export interface LlmRequest {
  system: string;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  signal?: AbortSignal;
}

export interface LanguageModel {
  readonly modelName: string;
  stream(req: LlmRequest): AsyncIterable<LlmEvent>;
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
