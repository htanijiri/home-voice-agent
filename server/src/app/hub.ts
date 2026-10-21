// 端末ごとの会話セッションと接続をまとめる。通信の口（WebSocket / MQTT）はここにイベントを渡す。
import type { Orchestrator } from "../core/orchestrator.js";
import type { Clock, SpeechToText, TextToSpeech } from "../core/ports.js";
import { type SessionHooks, VoiceSession, type VoiceSessionConfig } from "../core/voice-session.js";
import { errorFields, log } from "../log.js";
import { McpClient } from "../transports/xiaozhi/mcp.js";
import { type DeviceLink, OpusDecoder, type SinkTiming, XiaozhiSink } from "../transports/xiaozhi/link.js";

export interface HubDeps {
  stt: SpeechToText;
  tts: TextToSpeech;
  orchestrator: Orchestrator;
  clock: Clock;
  config: VoiceSessionConfig;
  householdId: string;
  hooks?: SessionHooks;
  /** 読み上げの音声を送り始めるときの間合い（省略時は既定値） */
  sinkTiming?: SinkTiming;
}

interface DeviceState {
  session: VoiceSession;
  mcp: McpClient;
  link?: DeviceLink;
  sink?: XiaozhiSink;
  decoder?: OpusDecoder;
  /** 端末が「聞き取り中」と言ってから音声を STT に流す */
  listening: boolean;
  lastSeenAt: number;
}

export type HubEvent =
  | { type: "online"; deviceId: string }
  | { type: "offline"; deviceId: string }
  | { type: "activity"; deviceId: string; what: "wake" | "listen" | "abort" | "hello" };

export class DeviceHub {
  private readonly devices = new Map<string, DeviceState>();
  private readonly listeners = new Set<(e: HubEvent) => void>();

  constructor(private readonly deps: HubDeps) {}

  on(fn: (e: HubEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit(e: HubEvent) {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch (err) {
        log.error("hub listener failed", errorFields(err));
      }
    }
  }

  private state(deviceId: string): DeviceState {
    let st = this.devices.get(deviceId);
    if (!st) {
      const mcp = new McpClient(() => undefined);
      const session = new VoiceSession(
        deviceId,
        this.deps.householdId,
        { ...this.deps, device: mcp },
        { stt() {}, emotion() {}, ttsStart() {}, sentence() {}, async audio() {}, ttsStop() {}, endConversation() {} },
      );
      st = { session, mcp, listening: false, lastSeenAt: 0 };
      this.devices.set(deviceId, st);
    }
    return st;
  }

  getSession(deviceId: string): VoiceSession | undefined {
    return this.devices.get(deviceId)?.session;
  }
  getLink(deviceId: string): DeviceLink | undefined {
    return this.devices.get(deviceId)?.link;
  }
  getMcp(deviceId: string): McpClient | undefined {
    return this.devices.get(deviceId)?.mcp;
  }
  /** つながっている端末の一覧 */
  onlineDevices(): string[] {
    return [...this.devices.entries()].filter(([, st]) => !!st.link).map(([id]) => id);
  }
  isBusy(deviceId: string): boolean {
    const st = this.devices.get(deviceId);
    return !!st && (st.session.state !== "IDLE" || !!st.link?.audioOpen);
  }

  /** 接続ができた（WebSocket の接続、または MQTT の接続） */
  attach(link: DeviceLink): void {
    const st = this.state(link.deviceId);
    if (st.link && st.link !== link) this.detach(st.link);
    st.link = link;
    st.sink?.close();
    st.sink = new XiaozhiSink(link, this.deps.sinkTiming);
    st.session.attachSink(st.sink);
    st.mcp.rebind((payload) => link.sendJson({ session_id: link.sessionId, type: "mcp", payload }));
    st.lastSeenAt = Date.now();
    this.emit({ type: "online", deviceId: link.deviceId });
  }

  /** 音声のやり取りが始まった（hello）。デコーダーを用意する */
  onHello(deviceId: string): void {
    const st = this.state(deviceId);
    st.decoder?.close();
    st.decoder = new OpusDecoder();
    st.listening = false;
    this.emit({ type: "activity", deviceId, what: "hello" });
    st.mcp.initialize().catch((err) => log.warn("mcp initialize failed", errorFields(err)));
  }

  onJson(deviceId: string, msg: Record<string, unknown>): void {
    const st = this.state(deviceId);
    st.lastSeenAt = Date.now();
    switch (msg.type) {
      case "listen":
        // 音声のやり取りを終えたあと（goodbye のあと）に届いた listen は受け付けない。
        // 会話を終えた直後、端末は読み上げ終了で自動的に聞き取りに戻って listen start を送ってくるため
        if (!st.link?.audioOpen) {
          // 通路が閉じているのに聞き取りを始めた端末は、会話を終えさせて待機に戻す（MQTT の goodbye）
          if (msg.state === "start" && st.link?.kind === "mqtt") {
            st.link.sendJson({ type: "goodbye", session_id: msg.session_id ?? st.link.sessionId });
          }
          break;
        }
        if (msg.state === "start") {
          st.listening = true;
          this.emit({ type: "activity", deviceId, what: "listen" });
          st.session.onListenStart();
        } else if (msg.state === "stop") {
          st.listening = false;
          st.session.onListenStop();
        } else if (msg.state === "detect") {
          this.emit({ type: "activity", deviceId, what: "wake" });
        }
        break;
      case "abort":
        st.listening = false;
        this.emit({ type: "activity", deviceId, what: "abort" });
        st.session.onAbort();
        break;
      case "mcp":
        st.mcp.onMessage((msg.payload ?? {}) as Parameters<McpClient["onMessage"]>[0]);
        break;
      default:
        break;
    }
  }

  onAudio(deviceId: string, opus: Buffer): void {
    const st = this.devices.get(deviceId);
    if (!st?.listening || !st.decoder || !st.link?.audioOpen) return;
    try {
      const pcm = st.decoder.decode(opus);
      if (log.isDebug()) this.debugLevel(deviceId, pcm);
      st.session.onAudio(pcm);
    } catch (err) {
      log.debug("opus decode failed", errorFields(err));
    }
  }

  /** 調べもの用：届いた音声の大きさ（RMS）を1秒ごとにログに出す。音声そのものは出さない */
  private levels = new Map<string, { n: number; sum: number; peak: number }>();
  private debugLevel(deviceId: string, pcm: Int16Array) {
    const l = this.levels.get(deviceId) ?? { n: 0, sum: 0, peak: 0 };
    for (const s of pcm) {
      l.sum += s * s;
      l.peak = Math.max(l.peak, Math.abs(s));
    }
    l.n += pcm.length;
    if (l.n >= 16000) {
      log.debug("audio level", { rms: Math.round(Math.sqrt(l.sum / l.n)), peak: l.peak, samples: l.n });
      this.levels.delete(deviceId);
    } else this.levels.set(deviceId, l);
  }

  /** 音声のやり取りが終わった（WebSocket の切断、MQTT の goodbye） */
  onAudioClosed(deviceId: string): void {
    const st = this.devices.get(deviceId);
    if (!st) return;
    st.listening = false;
    st.decoder?.close();
    st.decoder = undefined;
    st.session.onDisconnect();
  }

  /** 接続が切れた */
  detach(link: DeviceLink): void {
    const st = this.devices.get(link.deviceId);
    if (!st || st.link !== link) return;
    this.onAudioClosed(link.deviceId);
    st.link = undefined;
    st.sink?.close();
    st.sink = undefined;
    st.mcp.close();
    this.emit({ type: "offline", deviceId: link.deviceId });
  }

  close(): void {
    for (const st of this.devices.values()) {
      st.session.close();
      st.decoder?.close();
      st.sink?.close();
      st.mcp.close();
    }
    this.devices.clear();
  }
}
