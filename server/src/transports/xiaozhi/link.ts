// 端末との1本の接続（WebSocket、または MQTT＋UDP）を表す。通信方式の違いはここで吸収する。
import type { DeviceSink } from "../../core/voice-session.js";
import { DOWNLINK_RATE, OpusDecoder, OpusEncoder, resample, sendPaced } from "./opus.js";

export interface DeviceLink {
  readonly deviceId: string;
  readonly kind: "websocket" | "mqtt";
  sessionId: string;
  sendJson(obj: Record<string, unknown>): void;
  sendAudio(opus: Buffer): void;
  /** 音声のやり取り（会話）を終える。WebSocket は切断、MQTT は goodbye */
  closeAudioChannel(): void;
  readonly audioOpen: boolean;
}

/** 会話の出力を、Xiaozhi のメッセージと Opus の音声にして端末へ送る */
export class XiaozhiSink implements DeviceSink {
  private readonly encoder = new OpusEncoder(DOWNLINK_RATE);
  constructor(private readonly link: DeviceLink) {}

  private json(obj: Record<string, unknown>) {
    // 音声のやり取りが閉じている端末には送らない。待機中の端末が tts start を受けると、読み上げ→聞き取り中に入り、
    // 音声の通路がないまま「聞き取り中」で止まってしまう（実機で起きた）
    if (!this.link.audioOpen) return;
    this.link.sendJson({ session_id: this.link.sessionId, ...obj });
  }
  stt(text: string) {
    this.json({ type: "stt", text });
  }
  emotion(emotion: string) {
    this.json({ type: "llm", emotion, text: emotion === "thinking" ? "🤔" : "" });
  }
  ttsStart() {
    this.json({ type: "tts", state: "start" });
  }
  sentence(text: string) {
    this.json({ type: "tts", state: "sentence_start", text });
  }
  async audio(pcm: Int16Array, sampleRate: number, signal: AbortSignal) {
    if (!this.link.audioOpen) return;
    const frames = this.encoder.encodeAll(resample(pcm, sampleRate, DOWNLINK_RATE));
    await sendPaced(frames, (f) => this.link.sendAudio(f), signal);
  }
  ttsStop() {
    this.json({ type: "tts", state: "stop" });
  }
  endConversation() {
    this.link.closeAudioChannel();
  }
  close() {
    this.encoder.close();
  }
}

export { OpusDecoder };
