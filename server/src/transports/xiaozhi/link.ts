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

export interface SinkTiming {
  /** tts start から最初の音声を送るまで待つ時間 */
  startDelayMs: number;
  /** 読み上げの先頭に足す無音の長さ */
  leadingSilenceMs: number;
}

const DEFAULT_TIMING: SinkTiming = { startDelayMs: 200, leadingSilenceMs: 60 };

/** 会話の出力を、Xiaozhi のメッセージと Opus の音声にして端末へ送る */
export class XiaozhiSink implements DeviceSink {
  private readonly encoder = new OpusEncoder(DOWNLINK_RATE);
  /** tts start を送った時刻。最初の文の音声を送るまでの間だけ持つ */
  private ttsStartedAt: number | undefined;
  constructor(
    private readonly link: DeviceLink,
    private readonly timing: SinkTiming = DEFAULT_TIMING,
  ) {}

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
    this.ttsStartedAt = Date.now();
  }
  sentence(text: string) {
    this.json({ type: "tts", state: "sentence_start", text });
  }
  async audio(pcm: Int16Array, sampleRate: number, signal: AbortSignal) {
    if (!this.link.audioOpen) return;
    let samples = resample(pcm, sampleRate, DOWNLINK_RATE);
    if (this.ttsStartedAt !== undefined) {
      // 端末は tts start を受けてから「話し中」に切り替え、そのときに再生待ちの音声を捨てる（ResetDecoder）。
      // 切り替わる前に届いた音声も捨てるため、すぐ送ると返事の先頭（1〜2文字）が欠ける。
      // 切り替わるのを待ってから送り、スピーカーの立ち上がりの分の無音を先頭に足す
      const startedAt = this.ttsStartedAt;
      this.ttsStartedAt = undefined;
      await sleep(startedAt + this.timing.startDelayMs - Date.now(), signal);
      if (signal.aborted) return;
      samples = withLeadingSilence(samples, (DOWNLINK_RATE * this.timing.leadingSilenceMs) / 1000);
    }
    const frames = this.encoder.encodeAll(samples);
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

function withLeadingSilence(pcm: Int16Array, samples: number): Int16Array {
  const n = Math.max(0, Math.round(samples));
  if (n === 0) return pcm;
  const out = new Int16Array(n + pcm.length);
  out.set(pcm, n);
  return out;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export { OpusDecoder };
